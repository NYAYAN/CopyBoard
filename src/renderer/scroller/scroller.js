// Scroll capture: pick a region, scroll the app underneath it, get one tall image back.
//
// Three phases live in this one overlay window (see scroller.css for how they are switched):
//
//   select   The frozen screenshot from the main process is the backdrop, dimmed with a hole
//            where the region is — exactly like the snipper.
//   capture  Backdrop and dim are hidden and the window stops taking mouse events, so what
//            the user sees inside the outline is the REAL app and their scrolling reaches it.
//            Frames come from a live desktop stream (the same getUserMedia path the recorder
//            uses) and go to stitcher.js, which reports which rows are new.
//   review   The stitched page, scaled to fit, with copy/save.
//
// The window is excluded from screen capture by the main process (setContentProtection), so
// the outline, the HUD and the toolbar are invisible to our own stream and cannot end up
// baked into the result.

import { createStitcher } from './stitcher.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlay-canvas');
const overlayCtx = overlayCanvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const dimensionsLabel = document.getElementById('dimensions-label');
const toolbar = document.getElementById('toolbar');
const instruction = document.getElementById('instruction');
const hud = document.getElementById('hud');
const hudMain = document.getElementById('hud-main');
const hudStats = document.getElementById('hud-stats');
const hudWarn = document.getElementById('hud-warn');
const preview = document.getElementById('preview');
const previewCanvas = document.getElementById('preview-canvas');
const previewMeta = document.getElementById('preview-meta');
const previewWarn = document.getElementById('preview-warn');

// Sampling ~25 times a second. Faster buys little (the match only needs enough overlap) and
// costs a full crop + readback per frame; slower starts losing content to fast flicks.
const FRAME_MIN_INTERVAL = 40;
// Matching runs on a narrow strip downscaled from the crop rather than the crop itself:
// same rows, so every row index still lines up, but the per-frame getImageData is ~20x
// smaller. Downscaling also box-averages horizontally, which quiets the sampling noise.
const PROFILE_W = 128;
// A region has to be tall enough to leave a usable overlap after a scroll, and wide enough
// for the profile to say anything. Below this the stitcher would refuse every frame.
const MIN_CROP_W = 120;
const MIN_CROP_H = 240;
// Stop once the region has been STILL for this long — reaching the end of the page IS the
// natural end of a scroll capture, so the user should not have to say so twice.
//
// Stillness, not progress: a scroll that outruns the region leaves no overlap, so the
// stitcher refuses those frames and nothing is committed while the user is very much still
// scrolling. Timing that as idleness ended the capture under the user's hands, mid-page.
const IDLE_FINISH_MS = 2500;
const IDLE_HINT_MS = 1000;
// The other side of the same coin: something inside the region keeps changing (an
// animation, a video) so frames never settle AND never match. Stillness will never
// arrive, so the capture still needs a ceiling of its own — with a note saying so,
// because unlike reaching the end of a page this one is a failure the user can act on.
const COMMIT_STALL_MS = 12000;
// Give up when the region has clearly been scrolling for this long and NOTHING has matched.
// Timed from the first motion rather than from Start, so a user who takes a while to find
// their place is not cut off. Without it a capture that can never match has no ending of its
// own: the idle finish is armed only once something has been committed, which would leave
// cancelling as the only way out of a content-less capture.
const STALL_GIVEUP_MS = 8000;
// Accumulated rows are parked in tiles instead of one canvas that has to be reallocated
// every time it fills. 2048 rows keeps the slack in the final part-filled tile small.
const TILE_ROWS = 2048;
const MISS_WARN_STREAK = 3;

const state = {
    phase: 'select',
    isSelecting: false, isMoving: false, isResizing: false,
    activeHandle: null, resizeStartRect: null, selectionRect: null,
    startX: 0, startY: 0, dragOffX: 0, dragOffY: 0,
    dpr: window.devicePixelRatio || 1,
    scaleX: null, scaleY: null,
    sourceId: null, captureWidth: null, captureHeight: null,
    lastIgnoreState: null
};

// The decoded backdrop is retained for the lifetime of the overlay: assigning
// canvas.width/height WIPES a canvas, and behind a transparent window a wiped backdrop is
// indistinguishable from the live desktop until the capture comes out wrong.
let screenBitmap = null;

// Live capture state.
let stream = null;
let video = null;
let stitcher = null;
let crop = null;            // { x, y, w, h } in PHYSICAL pixels of the captured display
let frameA = null, frameB = null;   // ping-pong crop canvases
let curFrame = null, baseFrame = null, lastFrame = null;
let profileCanvas = null, profileCtx = null;
let headTiles = [];   // prepended rows, each tile filled bottom-up
let tailTiles = [];   // appended rows, each tile filled top-down
let totalRows = 0;
let frameTimer = null;
let idleTimer = null;
let lastSampleAt = 0;
let lastProgressAt = 0;  // last frame that committed rows
let lastMotionAt = 0;    // last frame where the region was seen to move at all
let missStreak = 0;
let firstMotionAt = 0;   // when the region was first seen to move at all
let finalCanvas = null;

// ── Backdrop ───────────────────────────────────────────────────────────────────
function paintScreen() {
    if (!screenBitmap) return false;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(screenBitmap, 0, 0, canvas.width, canvas.height);
    return true;
}

function drawOverlay(x, y, w, h) {
    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.save();
    overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.globalCompositeOperation = 'destination-out';
    overlayCtx.fillStyle = 'rgba(0,0,0,1)';
    overlayCtx.fillRect(x * sx, y * sy, w * sx, h * sy);
    overlayCtx.restore();
    overlayCtx.save();
    overlayCtx.strokeStyle = '#ffffff';
    overlayCtx.globalAlpha = 0.9;
    overlayCtx.lineWidth = Math.max(1, 2 * sx);
    overlayCtx.strokeRect(x * sx, y * sy, w * sx, h * sy);
    overlayCtx.restore();
}

function repaintOverlay() {
    if (state.phase === 'capture') return;
    const r = state.selectionRect;
    if (r) drawOverlay(r.x, r.y, r.w, r.h);
    else drawOverlay(0, 0, window.innerWidth, window.innerHeight);
}

function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    state.dpr = window.devicePixelRatio || 1;

    if (screenBitmap) {
        // A backdrop is loaded: restretch only. Reassigning width/height here would wipe it.
        [canvas, overlayCanvas].forEach(c => {
            c.style.width = w + 'px';
            c.style.height = h + 'px';
        });
        state.scaleX = canvas.width / w;
        state.scaleY = canvas.height / h;
        repaintOverlay();
        return;
    }

    if (state.scaleX == null) state.scaleX = state.dpr;
    if (state.scaleY == null) state.scaleY = state.dpr;
    [canvas, overlayCanvas].forEach(c => {
        c.width = w * state.dpr;
        c.height = h * state.dpr;
        c.style.width = w + 'px';
        c.style.height = h + 'px';
    });
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

if (!window.api) {
    alert('CRITICAL: window.api is UNDEFINED! Preload script failed to load.');
    throw new Error('CopyBoard scroller: preload bridge (window.api) unavailable.');
}

window.api.onCaptureReset(() => { if (state.phase === 'select') resetSelection(); });

window.api.onCaptureScreen((imageData, mode, sourceId, quality, captureWidth, captureHeight) => {
    const logicalW = window.innerWidth;
    const logicalH = window.innerHeight;
    const physW = captureWidth || logicalW;
    const physH = captureHeight || logicalH;

    state.sourceId = sourceId;
    state.captureWidth = physW;
    state.captureHeight = physH;
    state.scaleX = physW / logicalW;
    state.scaleY = physH / logicalH;
    state.dpr = window.devicePixelRatio || 1;

    screenBitmap = null;
    [canvas, overlayCanvas].forEach(c => {
        c.width = physW;
        c.height = physH;
        c.style.width = logicalW + 'px';
        c.style.height = logicalH + 'px';
    });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    resetSelection();

    const finish = () => {
        repaintOverlay();
        document.body.classList.add('ready');
        window.api.notifyReady();
    };

    // An unusable screenshot must never open the overlay: the window is transparent, so an
    // empty backdrop looks exactly like the live desktop and the failure would only surface
    // in the result. Self-heal by asking main to re-capture — we are still hidden here.
    const fail = (reason) => {
        window.api.sendDebugLog('Scroller: capture unusable (' + reason + ') — requesting re-capture');
        window.api.retryCapture();
    };

    if (imageData && imageData.byteLength) {
        createImageBitmap(new Blob([imageData], { type: 'image/png' })).then((bmp) => {
            screenBitmap = bmp;
            paintScreen();
            finish();
        }).catch((err) => fail('çözümlenemedi: ' + ((err && err.message) || 'bilinmeyen hata')));
    } else if (typeof imageData === 'string' && imageData.length > 100) {
        const img = new Image();
        img.onload = () => { screenBitmap = img; paintScreen(); finish(); };
        img.onerror = () => fail('görüntü yüklenemedi');
        img.src = imageData;
    } else {
        fail('boş görüntü verisi');
    }
});

// ── Region selection ───────────────────────────────────────────────────────────
function resetSelection() {
    state.isSelecting = state.isMoving = state.isResizing = false;
    state.selectionRect = null;
    selectionBox.classList.add('hidden');
    toolbar.classList.add('hidden');
    document.body.classList.remove('selecting');
    repaintOverlay();
}

function updateDimensions(w, h) {
    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    dimensionsLabel.textContent = `${Math.round(w * sx)} x ${Math.round(h * sy)}`;
}

// Centred under the selection, flipped above it when there is no room below.
function placeToolbar() {
    const r = state.selectionRect;
    if (!r) return;
    toolbar.classList.remove('hidden');
    const tw = toolbar.offsetWidth;
    const th = toolbar.offsetHeight;
    let left = r.x + (r.w - tw) / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - tw - 10));
    let top = r.y + r.h + 16;
    if (top + th > window.innerHeight - 10) top = r.y - th - 16;
    if (top < 10) top = 10;
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
}

function placeHud() {
    const r = state.selectionRect;
    if (!r) return;
    const hw = hud.offsetWidth;
    const hh = hud.offsetHeight;
    let left = r.x + (r.w - hw) / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - hw - 10));
    let top = r.y - hh - 12;
    if (top < 10) top = Math.min(r.y + r.h + 12, window.innerHeight - hh - 10);
    hud.style.left = left + 'px';
    hud.style.top = top + 'px';
}

window.addEventListener('mousedown', (e) => {
    if (state.phase !== 'select') return;
    if (e.target.closest('.toolbar')) return;

    if (state.selectionRect) {
        if (e.target.classList.contains('resize-handle')) {
            state.isResizing = true;
            state.activeHandle = e.target.dataset.handle;
            const b = selectionBox.getBoundingClientRect();
            state.resizeStartRect = { left: b.left, top: b.top, width: b.width, height: b.height };
            state.startX = e.clientX; state.startY = e.clientY;
            toolbar.classList.add('hidden');
            document.body.classList.add('selecting');
            return;
        }
        if (e.target === selectionBox) {
            state.isMoving = true;
            const b = selectionBox.getBoundingClientRect();
            state.dragOffX = e.clientX - b.left;
            state.dragOffY = e.clientY - b.top;
            toolbar.classList.add('hidden');
            return;
        }
    }

    window.api.claimCaptureMonitor(); // a new selection clears the other monitors'
    resetSelection();
    state.isSelecting = true;
    document.body.classList.add('selecting');
    state.startX = e.clientX; state.startY = e.clientY;
    selectionBox.style.left = state.startX + 'px';
    selectionBox.style.top = state.startY + 'px';
    selectionBox.style.width = selectionBox.style.height = '0px';
    selectionBox.classList.remove('hidden');
    updateDimensions(0, 0);
});

window.addEventListener('mousemove', (e) => {
    if (state.phase === 'capture') { updateIgnoreMouse(e); return; }
    if (state.phase !== 'select') return;

    if (state.isResizing) {
        const dx = e.clientX - state.startX, dy = e.clientY - state.startY;
        let { left, top, width, height } = state.resizeStartRect;
        if (state.activeHandle.includes('e')) width += dx;
        if (state.activeHandle.includes('s')) height += dy;
        if (state.activeHandle.includes('w')) { left += dx; width -= dx; }
        if (state.activeHandle.includes('n')) { top += dy; height -= dy; }
        if (width < 20) { if (state.activeHandle.includes('w')) left = state.resizeStartRect.left + state.resizeStartRect.width - 20; width = 20; }
        if (height < 20) { if (state.activeHandle.includes('n')) top = state.resizeStartRect.top + state.resizeStartRect.height - 20; height = 20; }
        Object.assign(selectionBox.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
        updateDimensions(width, height);
        drawOverlay(left, top, width, height);
    } else if (state.isMoving) {
        const nx = Math.max(0, Math.min(e.clientX - state.dragOffX, window.innerWidth - selectionBox.offsetWidth));
        const ny = Math.max(0, Math.min(e.clientY - state.dragOffY, window.innerHeight - selectionBox.offsetHeight));
        selectionBox.style.left = nx + 'px';
        selectionBox.style.top = ny + 'px';
        drawOverlay(nx, ny, selectionBox.offsetWidth, selectionBox.offsetHeight);
    } else if (state.isSelecting) {
        const w = Math.abs(e.clientX - state.startX);
        const h = Math.abs(e.clientY - state.startY);
        const x = Math.min(e.clientX, state.startX);
        const y = Math.min(e.clientY, state.startY);
        Object.assign(selectionBox.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        updateDimensions(w, h);
        drawOverlay(x, y, w, h);
    }
});

window.addEventListener('mouseup', () => {
    if (state.phase !== 'select') return;
    if (state.isResizing || state.isMoving || state.isSelecting) {
        const b = selectionBox.getBoundingClientRect();
        if (state.isSelecting && (b.width < 10 || b.height < 10)) { resetSelection(); return; }
        state.selectionRect = { x: b.left, y: b.top, w: b.width, h: b.height };
        placeToolbar();
        showRegionHint();
    }
    state.isResizing = state.isMoving = state.isSelecting = false;
    document.body.classList.remove('selecting');
});

// Warn about a region the stitcher cannot work with BEFORE the user starts scrolling.
function showRegionHint() {
    const c = cropRect();
    if (!c) return;
    if (c.h < MIN_CROP_H || c.w < MIN_CROP_W) {
        instruction.textContent = t('Alan çok küçük — kaydırmalı yakalama için daha büyük bir bölge seçin');
        instruction.classList.add('warn');
    } else {
        instruction.textContent = t('Başlat’a basın, sonra bu alanın üstünde kaydırın');
        instruction.classList.remove('warn');
    }
}

// Selection in PHYSICAL pixels of the captured display, clamped to it.
function cropRect() {
    const r = state.selectionRect;
    if (!r || !state.captureWidth) return null;
    const sx = state.scaleX, sy = state.scaleY;
    const x = Math.max(0, Math.round(r.x * sx));
    const y = Math.max(0, Math.round(r.y * sy));
    const w = Math.max(1, Math.min(Math.round(r.w * sx), state.captureWidth - x));
    const h = Math.max(1, Math.min(Math.round(r.h * sy), state.captureHeight - y));
    return { x, y, w, h };
}

// ── Capture phase ──────────────────────────────────────────────────────────────
function setPhase(next) {
    state.phase = next;
    document.body.classList.remove('phase-select', 'phase-capture', 'phase-review');
    document.body.classList.add('phase-' + next);
}

function makeFrameCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cc = c.getContext('2d');
    cc.imageSmoothingEnabled = false;
    return { canvas: c, ctx: cc };
}

async function beginCapture() {
    if (state.phase !== 'select') return;
    crop = cropRect();
    if (!crop || !state.sourceId) return;
    if (crop.w < MIN_CROP_W || crop.h < MIN_CROP_H) { showRegionHint(); return; }

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: state.sourceId,
                    minWidth: state.captureWidth,
                    maxWidth: state.captureWidth,
                    minHeight: state.captureHeight,
                    maxHeight: state.captureHeight
                }
            }
        });

        video = document.createElement('video');
        video.muted = true;
        video.srcObject = stream;
        await video.play();
    } catch (err) {
        console.error('Scroll capture stream failed:', err);
        instruction.textContent = t('Ekran akışı başlatılamadı: ') + ((err && err.message) || err);
        instruction.classList.add('warn');
        stopStream();
        return;
    }

    frameA = makeFrameCanvas(crop.w, crop.h);
    frameB = makeFrameCanvas(crop.w, crop.h);
    curFrame = frameA;
    baseFrame = null;
    lastFrame = null;

    profileCanvas = document.createElement('canvas');
    profileCanvas.width = PROFILE_W;
    profileCanvas.height = crop.h;
    profileCtx = profileCanvas.getContext('2d', { willReadFrequently: true });
    profileCtx.imageSmoothingEnabled = true; // horizontal box average, not nearest-neighbour

    headTiles = [];
    tailTiles = [];
    totalRows = 0;
    missStreak = 0;
    firstMotionAt = 0;
    finalCanvas = null;
    stitcher = createStitcher({ outputWidth: crop.w });

    setPhase('capture');
    hud.classList.remove('hidden');
    hudWarn.classList.add('hidden');
    updateHud(t('Şimdi kaydırın'));
    placeHud();
    placeToolbar();

    // The main process closes the other monitors' overlays and arms a global Escape; from
    // here the window passes mouse events through so scrolling reaches the app underneath.
    window.api.scrollBegin();
    state.lastIgnoreState = true;
    window.api.setIgnoreMouseEvents(true, { forward: true });

    lastSampleAt = 0;
    lastProgressAt = lastMotionAt = performance.now();
    startFrameLoop();
}

function startFrameLoop() {
    // A desktop stream only produces frames when the screen CHANGES, so once the user stops
    // scrolling on a still page the frame callback stops firing entirely. The finish check
    // cannot live in there or the capture would hang at the end of every page it completes.
    idleTimer = setInterval(() => {
        if (state.phase !== 'capture') return;
        const now = performance.now();
        refreshHud(now);
        if (stitcher.started) {
            checkAutoFinish(now);
        } else if (firstMotionAt && now - firstMotionAt > STALL_GIVEUP_MS) {
            finishCapture(null); // routes to the "nothing was captured" path
        }
    }, 250);

    // requestVideoFrameCallback fires once per DECODED frame, so the loop follows the
    // stream instead of guessing at it. setInterval is the fallback where it is missing.
    if (typeof video.requestVideoFrameCallback === 'function') {
        const tick = () => {
            if (state.phase !== 'capture') return;
            const now = performance.now();
            if (now - lastSampleAt >= FRAME_MIN_INTERVAL) {
                lastSampleAt = now;
                sampleFrame(now);
            }
            if (state.phase === 'capture') video.requestVideoFrameCallback(tick);
        };
        video.requestVideoFrameCallback(tick);
    } else {
        frameTimer = setInterval(() => {
            if (state.phase !== 'capture') return;
            sampleFrame(performance.now());
        }, FRAME_MIN_INTERVAL);
    }
}

function stopFrameLoop() {
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

function stopStream() {
    stopFrameLoop();
    if (stream) {
        try { stream.getTracks().forEach(track => track.stop()); } catch (e) { /* already gone */ }
        stream = null;
    }
    if (video) { try { video.pause(); } catch (e) { } video.srcObject = null; video = null; }
}

// Copy `height` rows starting at `srcTop` from a crop canvas onto one end of the strip.
//
// Two chains, because a capture grows from whichever end the user scrolls towards. `tailTiles`
// fill downward and are composed in order; `headTiles` fill UPWARD from the bottom of each
// tile and are composed in reverse, which is what lets rows be prepended without moving any
// pixels that are already placed.
function addRows(srcCanvas, srcTop, height, side) {
    const head = side === 'top';
    const chain = head ? headTiles : tailTiles;
    let remaining = height;

    while (remaining > 0) {
        let tile = chain[chain.length - 1];
        if (!tile || tile.rows >= TILE_ROWS) {
            tile = { ...makeFrameCanvas(crop.w, TILE_ROWS), rows: 0 };
            chain.push(tile);
        }
        const n = Math.min(remaining, TILE_ROWS - tile.rows);
        if (head) {
            // Take rows from the BOTTOM of what is left to place, so the tile fills upward
            // and the strip stays in page order.
            tile.ctx.drawImage(srcCanvas, 0, srcTop + remaining - n, crop.w, n,
                0, TILE_ROWS - tile.rows - n, crop.w, n);
        } else {
            tile.ctx.drawImage(srcCanvas, 0, srcTop + (height - remaining), crop.w, n,
                0, tile.rows, crop.w, n);
        }
        tile.rows += n;
        remaining -= n;
        totalRows += n;
    }
}

function sampleFrame(now) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    // The stream should come back at the size we asked for, but a driver that rounds it
    // would silently shift the crop; scaling by the ratio keeps the region where the user
    // put it either way.
    const kx = vw / state.captureWidth;
    const ky = vh / state.captureHeight;

    const drawn = curFrame;
    drawn.ctx.drawImage(video,
        crop.x * kx, crop.y * ky, crop.w * kx, crop.h * ky,
        0, 0, crop.w, crop.h);

    profileCtx.drawImage(drawn.canvas, 0, 0, crop.w, crop.h, 0, 0, PROFILE_W, crop.h);
    const decision = stitcher.push(profileCtx.getImageData(0, 0, PROFILE_W, crop.h));

    if (decision.base) addRows(baseFrame.canvas, decision.base.top, decision.base.height, 'bottom');
    if (decision.add) addRows(drawn.canvas, decision.add.top, decision.add.height, decision.add.side);

    lastFrame = drawn;
    // Whenever the stitcher advanced its base profile, the matching canvas has to advance
    // too — including on 'seen', where the frame matched but held no new rows.
    const advanced = decision.status === 'need-more' || decision.status === 'seen'
        || decision.base || decision.add;
    if (advanced) {
        baseFrame = drawn;
        curFrame = drawn === frameA ? frameB : frameA;
    }
    if (decision.offset !== 0 || decision.status === 'reject') {
        if (!firstMotionAt) firstMotionAt = now;
    }
    // 'idle' is the stitcher's own verdict that the region barely moved. Everything else —
    // a refused frame included — means the picture under the pointer is still changing, so
    // the user has not finished with it.
    if (decision.status !== 'idle' && decision.status !== 'need-more') lastMotionAt = now;
    if (decision.base || decision.add) {
        lastProgressAt = now;
        missStreak = 0;
    } else if (decision.status === 'reject') {
        missStreak++;
    }

    if (decision.status === 'full') {
        finishCapture(t('Boyut sınırına ulaşıldı'));
        return;
    }

    refreshHud(now);
    checkAutoFinish(now);
}

// Asked from both loops, so they cannot drift apart: a still page stops producing frames
// altogether, so only the timer can see the end of a scroll — and only the frame path sees
// a scroll that is still going.
function checkAutoFinish(now) {
    if (!stitcher.started) return;
    // The end of the page is the end of the capture: nothing has moved for a while, so
    // there is nothing left to scroll to, and making the user confirm that would add a
    // step to every single capture.
    if (now - lastMotionAt > IDLE_FINISH_MS) {
        finishCapture(null);
    } else if (now - lastProgressAt > COMMIT_STALL_MS) {
        // Still moving, but nothing has landed for a long time. Ending silently here would
        // read as the same bug this clock was split to fix, so it says why.
        finishCapture(t('Kaydırma izlenemedi — daha yavaş kaydırın'));
    }
}

function updateHud(main) {
    hudMain.textContent = main;
    const rows = totalRows;
    hudStats.textContent = rows
        ? t('{h} px · {n} birleşim', { h: rows, n: stitcher.commits })
        : '';
}

function refreshHud(now) {
    if (!stitcher.started) {
        updateHud(t('Şimdi kaydırın'));
    } else if (now - lastMotionAt > IDLE_HINT_MS) {
        // Follows the same clock as the finish: announcing "finishing" while the user is
        // mid-scroll was the visible half of the bug that ended those captures.
        updateHud(t('Bitiriliyor…'));
    } else {
        updateHud(t('Yakalanıyor'));
    }

    if (missStreak >= MISS_WARN_STREAK) {
        hudWarn.textContent = t('Daha yavaş kaydırın');
        hudWarn.classList.remove('hidden');
    } else if (!hudWarn.classList.contains('hidden') && missStreak === 0) {
        hudWarn.classList.add('hidden');
    }
    placeHud();
}

// ── Finish & review ────────────────────────────────────────────────────────────
function releaseTiles() {
    [...headTiles, ...tailTiles].forEach(tile => { tile.canvas.width = tile.canvas.height = 0; });
    headTiles = [];
    tailTiles = [];
}

// Head chain in reverse (each of those tiles is filled from its bottom), then the tail chain
// in order, with the sticky header and footer laid over the two ends.
function composeFinal(header, footer) {
    const out = document.createElement('canvas');
    out.width = crop.w;
    out.height = totalRows + header + footer;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;

    let y = header;
    for (let i = headTiles.length - 1; i >= 0; i--) {
        const tile = headTiles[i];
        octx.drawImage(tile.canvas, 0, TILE_ROWS - tile.rows, crop.w, tile.rows, 0, y, crop.w, tile.rows);
        y += tile.rows;
    }
    for (const tile of tailTiles) {
        octx.drawImage(tile.canvas, 0, 0, crop.w, tile.rows, 0, y, crop.w, tile.rows);
        y += tile.rows;
    }

    // Sticky chrome, once, at the ends. Any frame is a valid source — chrome is by definition
    // the part that never changed — so the last one is used for both.
    if (lastFrame) {
        if (header > 0) octx.drawImage(lastFrame.canvas, 0, 0, crop.w, header, 0, 0, crop.w, header);
        if (footer > 0) {
            octx.drawImage(lastFrame.canvas, 0, crop.h - footer, crop.w, footer,
                0, out.height - footer, crop.w, footer);
        }
    }

    // Release the tiles as soon as they are composed — at this moment two full copies of a
    // long page are in memory, which is the peak of the whole feature.
    releaseTiles();
    return out;
}

function finishCapture(note) {
    if (state.phase !== 'capture') return;

    const captured = totalRows;
    const gaps = stitcher.gaps;
    // Sticky chrome is not part of the strip: it would be stranded mid-image the moment
    // anything was prepended above it. composeFinal lays it over the two ends instead.
    const header = stitcher.started && lastFrame ? stitcher.headerHeight : 0;
    const footer = stitcher.started && lastFrame ? stitcher.footerHeight : 0;

    stopStream();
    window.api.scrollEnd();
    state.lastIgnoreState = false;
    window.api.setIgnoreMouseEvents(false);
    hud.classList.add('hidden');

    if (!captured) {
        // Nothing was ever matched — most likely the user never scrolled, or the content
        // moves in a way the stitcher cannot follow. Back to selection rather than a dead end.
        releaseTiles();
        setPhase('select');
        paintScreen();
        repaintOverlay();
        placeToolbar();
        instruction.classList.remove('hidden');
        instruction.textContent = t('Hiçbir şey yakalanamadı — Başlat’a bastıktan sonra alanın üstünde kaydırın');
        instruction.classList.add('warn');
        return;
    }

    finalCanvas = composeFinal(header, footer);
    setPhase('review');
    repaintOverlay();          // full dim behind the preview
    showPreview(note, gaps);
}

function showPreview(note, gaps) {
    const maxW = Math.min(window.innerWidth * 0.5, 520);
    const maxH = window.innerHeight * 0.6;
    const scale = Math.min(maxW / finalCanvas.width, maxH / finalCanvas.height, 1);
    previewCanvas.width = Math.max(1, Math.round(finalCanvas.width * scale));
    previewCanvas.height = Math.max(1, Math.round(finalCanvas.height * scale));
    const pctx = previewCanvas.getContext('2d');
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(finalCanvas, 0, 0, previewCanvas.width, previewCanvas.height);

    previewMeta.textContent = `${finalCanvas.width} × ${finalCanvas.height} px`;

    const warnings = [];
    if (note) warnings.push(note);
    if (gaps > 0) warnings.push(t('{n} kare eşleşmedi — içerik eksik olabilir', { n: gaps }));
    if (warnings.length) {
        previewWarn.textContent = warnings.join(' · ');
        previewWarn.classList.remove('hidden');
    } else {
        previewWarn.classList.add('hidden');
    }

    preview.classList.remove('hidden');
    instruction.classList.add('hidden');
    // Centre the toolbar under the preview panel now that it has a size.
    const pr = preview.getBoundingClientRect();
    toolbar.classList.remove('hidden');
    toolbar.style.left = Math.max(10, pr.left + (pr.width - toolbar.offsetWidth) / 2) + 'px';
    toolbar.style.top = Math.min(pr.bottom + 12, window.innerHeight - toolbar.offsetHeight - 10) + 'px';
}

// Export is not instant — a stitched page is tens of megapixels and the PNG encode alone
// runs for seconds. Saying so on the button matters more here than anywhere else in the
// app: with nothing changing, the click looked like it had missed, so it got pressed
// again, and EVERY press ran another encode and asked for another save dialog. Those
// dialogs then arrived one after another, minutes later, on top of whatever the user had
// moved on to — one of them turned up right after a copy had already finished.
let exporting = false;
let exportHold = null;
const copyBtn = document.getElementById('btn-copy');
const saveBtn = document.getElementById('btn-save');

function setExporting(btn, busyText) {
    exporting = true;
    [copyBtn, saveBtn].forEach(b => { if (b) b.disabled = true; });
    const label = btn && btn.querySelector('span');
    if (label) {
        label.dataset.idle = label.textContent;
        label.textContent = busyText;
    }
}

function clearExporting() {
    if (exportHold) { clearTimeout(exportHold); exportHold = null; }
    exporting = false;
    [copyBtn, saveBtn].forEach(b => {
        if (!b) return;
        b.disabled = false;
        const label = b.querySelector('span');
        if (label && label.dataset.idle) {
            label.textContent = label.dataset.idle;
            delete label.dataset.idle;
        }
    });
}

// PNG as bytes, not a data URL: a stitched page runs to tens of megabytes and base64 would
// add a third on top of a full string copy at each end of the IPC hop.
// holdForDialog: stay busy past the handoff, until the main process reports that the save
// panel is on screen. The encode is only half the wait — the buffer still has to cross the
// IPC and the panel still has to come up — and a button that returns to "Kaydet" during
// that gap is the button that looked like it had done nothing.
function exportPng(btn, busyText, send, holdForDialog) {
    if (!finalCanvas || exporting) return;
    setExporting(btn, busyText);
    finalCanvas.toBlob((blob) => {
        if (!blob) { clearExporting(); alert(t('Görüntü oluşturulamadı.')); return; }
        blob.arrayBuffer()
            .then((ab) => {
                send(ab);
                if (!holdForDialog) return clearExporting();
                // Never stuck: if that report never comes, the buttons come back anyway.
                exportHold = setTimeout(clearExporting, 15000);
            })
            .catch((err) => { clearExporting(); alert(t('Görüntü aktarılamadı: ') + err.message); });
    }, 'image/png');
}

// The panel is a sheet on this window, so it blocks the toolbar while it is up; releasing
// the buttons here is what puts them back for a CANCELLED save, where this overlay stays.
if (window.api.onSaveDialogOpen) window.api.onSaveDialogOpen(clearExporting);

// ── Click-through while capturing ──────────────────────────────────────────────
// The window ignores the mouse so scrolling reaches the app underneath, but the toolbar
// still has to be clickable. mousemove keeps arriving because setIgnoreMouseEvents is used
// with forward:true, so hovering the bar hands events back for as long as the pointer is
// over it. Same approach as the recorder's toolbar.
function updateIgnoreMouse(e) {
    if (state.phase !== 'capture') return;
    const tr = toolbar.getBoundingClientRect();
    const pad = 10;
    const overToolbar = e.clientX >= tr.left - pad && e.clientX <= tr.right + pad &&
        e.clientY >= tr.top - pad && e.clientY <= tr.bottom + pad;
    const shouldIgnore = !overToolbar;
    if (shouldIgnore !== state.lastIgnoreState) {
        window.api.setIgnoreMouseEvents(shouldIgnore, { forward: true });
        state.lastIgnoreState = shouldIgnore;
    }
}

// ── Buttons & keys ─────────────────────────────────────────────────────────────
function cancelAll() {
    if (state.phase === 'capture') {
        stopStream();
        window.api.scrollEnd();
        window.api.setIgnoreMouseEvents(false);
    }
    window.api.closeSnipper();
}

const actions = {
    'btn-start': () => beginCapture(),
    'btn-finish': () => finishCapture(null),
    'btn-copy': () => exportPng(copyBtn, t('Kopyalanıyor…'), (ab) => window.api.sendCopyBuffer(ab), false),
    'btn-save': () => exportPng(saveBtn, t('Kaydediliyor…'), (ab) => window.api.sendSaveBuffer(ab), true),
    'btn-close': () => cancelAll()
};

Object.entries(actions).forEach(([id, action]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        try { action(); } catch (err) { alert('Error: ' + err.message); }
    });
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { cancelAll(); return; }
    const cmdOrCtrl = e.ctrlKey || e.metaKey;
    if (state.phase === 'select' && e.key === 'Enter' && state.selectionRect) {
        e.preventDefault();
        beginCapture();
    } else if (state.phase === 'capture' && e.key === 'Enter') {
        e.preventDefault();
        finishCapture(null);
    } else if (state.phase === 'review') {
        if (e.key === 'Enter' || (cmdOrCtrl && e.key.toLowerCase() === 'c')) {
            e.preventDefault();
            actions['btn-copy']();
        } else if (cmdOrCtrl && e.key.toLowerCase() === 's') {
            e.preventDefault();
            actions['btn-save']();
        }
    }
});

window.addEventListener('beforeunload', () => stopStream());

// Toolbar labels are drawn in-page — a native tooltip is invisible behind an always-on-top
// overlay. See ../shared/overlay-tooltip.js.
//
// Queued on DOMContentLoaded rather than called outright, unlike the snipper's classic
// script: a module runs BEFORE that event, so init() would read the title attributes while
// they are still the Turkish source and freeze them into an English UI. i18n.js registered
// its own listener while the document was parsing, so ours is guaranteed to run after it.
if (document.readyState === 'complete') {
    window.CopyBoardOverlayTooltip.init('.toolbar');
} else {
    document.addEventListener('DOMContentLoaded', () => window.CopyBoardOverlayTooltip.init('.toolbar'));
}
