const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlay-canvas');
const overlayCtx = overlayCanvas.getContext('2d');
const drawCanvas = document.getElementById('draw-canvas');
const drawCtx = drawCanvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const toolbar = document.getElementById('toolbar');
const textInputContainer = document.getElementById('text-input-container');
const textInput = document.getElementById('text-input');
const textDragHandle = document.getElementById('text-drag-handle');


const state = {
    isSelecting: false, isDrawing: false, isMoving: false, isResizing: false, isDraggingText: false,
    activeHandle: null, resizeStartRect: null, selectionRect: null, activeTool: null,
    startX: 0, startY: 0, dragOffX: 0, dragOffY: 0, savedImageData: null,
    history: [],
    dpr: window.devicePixelRatio || 1,
    scaleX: null,
    scaleY: null,
    selectedColor: '#ff0000'
};

// A capture targets a single monitor: when a selection starts on one monitor, the others
// clear theirs (reset to full dim) so only the latest selection exists — see the
// claimCaptureMonitor() call below and the onCaptureReset handler.

// Blur perf: throttle the recompute and reuse the scratch canvas
let lastBlurTime = 0;
let lastBlurX = 0, lastBlurY = 0; // last pointer pos so mouseup can commit the release rect
let blurTempCanvas = null;

// The decoded capture is kept for the lifetime of the overlay so the screen layer can be
// repainted at any time. Assigning canvas.width/height WIPES a canvas, and this window is
// transparent: once the screenshot was wiped the live desktop showed through, so the snip
// looked perfectly normal right up until the copy pasted as a black rectangle.
let screenBitmap = null;
let screenPainted = false;

// Paint the retained capture into the screen layer at its native resolution.
function paintScreen() {
    if (!screenBitmap) return false;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(screenBitmap, 0, 0, canvas.width, canvas.height);
    screenPainted = true;
    return true;
}

// Dim + selection hole for the current selection (full dim when there is none).
function repaintOverlay() {
    const r = state.selectionRect;
    if (r) drawOverlay(r.x, r.y, r.w, r.h);
    else drawOverlay(0, 0, window.innerWidth, window.innerHeight);
}

function saveState() {
    state.history.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
    // Each entry is a full-canvas RGBA snapshot (~8MB at 1080p, ~33MB at 4K, ~132MB at
    // 8K), so cap the history by BYTES rather than a fixed count: up to 10 steps but at
    // most ~256MB total, never fewer than 3 steps.
    const bytesPerEntry = drawCanvas.width * drawCanvas.height * 4;
    const maxEntries = Math.max(3, Math.min(10, Math.floor(268435456 / bytesPerEntry)));
    while (state.history.length > maxEntries) state.history.shift();
}

function undo() {
    if (state.history.length > 0) {
        const last = state.history.pop();
        drawCtx.putImageData(last, 0, 0);
    }
}

function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    state.dpr = dpr;

    if (screenBitmap) {
        // A capture is loaded: the canvases stay at the capture's physical resolution and
        // only get restretched. Reassigning width/height here would wipe the screenshot AND
        // the user's annotations and invalidate every undo snapshot — all of it invisible
        // behind a transparent overlay, and only noticed once the copy pastes as black.
        [canvas, drawCanvas, overlayCanvas].forEach(c => {
            c.style.width = w + 'px';
            c.style.height = h + 'px';
        });
        state.scaleX = canvas.width / w;
        state.scaleY = canvas.height / h;
        initDrawCtx();
        repaintOverlay();
        return;
    }

    if (state.scaleX == null) state.scaleX = dpr;
    if (state.scaleY == null) state.scaleY = dpr;

    [canvas, drawCanvas, overlayCanvas].forEach(c => {
        c.width = w * dpr;
        c.height = h * dpr;
        c.style.width = w + 'px';
        c.style.height = h + 'px';
    });

    drawCtx.setTransform(1, 0, 0, 1, 0, 0);
    initDrawCtx();
}

function initDrawCtx() {
    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    const scale = (sx + sy) / 2;

    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.strokeStyle = drawCtx.fillStyle = state.selectedColor || '#ff0000';
    drawCtx.lineWidth = 3 * scale;
    drawCtx.font = (20 * scale) + "px Arial";
}

// Draw the dimming overlay with a clear "hole" for the selection area
function drawOverlay(selX, selY, selW, selH) {
    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.save();
    // Fill entire canvas with semi-transparent black
    overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    // Cut out the selection area using destination-out composite
    overlayCtx.globalCompositeOperation = 'destination-out';
    overlayCtx.fillStyle = 'rgba(0,0,0,1)';
    overlayCtx.fillRect(selX * sx, selY * sy, selW * sx, selH * sy);
    overlayCtx.restore();
    // Draw border around selection using FIXED white color
    // This decouples the selection UI from the drawing tool color
    overlayCtx.save();
    overlayCtx.strokeStyle = '#ffffff';
    overlayCtx.globalAlpha = 0.9;
    overlayCtx.lineWidth = Math.max(1, 2 * sx);
    overlayCtx.strokeRect(selX * sx, selY * sy, selW * sx, selH * sy);
    overlayCtx.globalAlpha = 1.0;
    overlayCtx.restore();
}

function clearOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}


window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Preload Verification ---
if (!window.api) {
    alert('CRITICAL: window.api is UNDEFINED! Preload script failed to load.');
    // Abort: without the bridge nothing below works. Throwing stops the rest of the module
    // so we fail with one clear message instead of a cascade of TypeErrors.
    throw new Error('CopyBoard snipper: preload bridge (window.api) unavailable.');
}
console.log('window.api is available:', Object.keys(window.api));

// Another monitor started a selection → clear ours (back to full dim), stay interactive.
window.api.onCaptureReset(() => resetUI());

// Ensure sharp pixel rendering
ctx.imageSmoothingEnabled = false;
drawCtx.imageSmoothingEnabled = false;

// --- Capture & Initialize Screen ---
window.api.onCaptureScreen((imageData, mode, sourceId, quality, captureWidth, captureHeight) => {
    const logicalW = window.innerWidth;
    const logicalH = window.innerHeight;

    // captureWidth/Height are physical pixel dimensions from main process
    const physW = captureWidth || logicalW;
    const physH = captureHeight || logicalH;

    // Set all canvases to physical pixel resolution
    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = logicalW + 'px';
    canvas.style.height = logicalH + 'px';
    [drawCanvas, overlayCanvas].forEach(c => {
        c.width = physW;
        c.height = physH;
        c.style.width = logicalW + 'px';
        c.style.height = logicalH + 'px';
    });

    state.scaleX = physW / logicalW;
    state.scaleY = physH / logicalH;
    state.dpr = window.devicePixelRatio || 1;

    screenBitmap = null;
    screenPainted = false;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    initDrawCtx(); // Ensure context properties are set after canvas.width/height resets them
    clearOverlay();
    resetUI();

    const finish = () => {
        drawOverlay(0, 0, logicalW, logicalH);
        document.body.classList.add('ready');
        window.api.notifyReady();
    };

    // An empty screen layer is invisible behind a transparent overlay — the live desktop
    // shows through, the user annotates and copies as usual, and the failure only surfaces
    // as a black rectangle in whatever they paste into. So an unusable screenshot must never
    // open the overlay. Self-heal: ask main to re-capture and re-send (this handler re-runs
    // with the fresh data). The window is still hidden at this point, so the retry is
    // invisible; main gives up after a few rounds with a toast + teardown.
    const fail = (reason) => {
        window.api.sendDebugLog('Snipper: capture unusable (' + reason + ') — requesting re-capture');
        window.api.retryCapture();
    };

    // Binary PNG buffer from main — decode via ImageBitmap (no base64/string round-trip).
    if (imageData && imageData.byteLength) {
        createImageBitmap(new Blob([imageData], { type: 'image/png' })).then((bmp) => {
            // Draw at native resolution — pixel-perfect like Snipping Tool. The bitmap is
            // kept (not closed) so resizeCanvas/getFinalImage can repaint from it.
            screenBitmap = bmp;
            paintScreen();
            finish();
        }).catch((err) => fail('çözümlenemedi: ' + ((err && err.message) || 'bilinmeyen hata')));
    } else if (typeof imageData === 'string' && imageData.length > 100) {
        // Legacy data-URL path, kept as a fallback.
        const img = new Image();
        img.onload = () => {
            screenBitmap = img;
            paintScreen();
            finish();
        };
        img.onerror = () => fail('görüntü yüklenemedi');
        img.src = imageData;
    } else {
        // Capture failed entirely. This shouldn't happen with the current capture-service.
        fail('boş görüntü verisi');
    }
});

function resetUI() {
    Object.assign(state, {
        isSelecting: false, isDrawing: false, isMoving: false, isResizing: false,
        isDraggingText: false, selectionRect: null, activeTool: null, history: []
    });
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    selectionBox.style.display = toolbar.style.display = textInputContainer.style.display = 'none';
    selectionBox.classList.add('hidden');
    // Show full-screen dim when no selection is active
    drawOverlay(0, 0, window.innerWidth, window.innerHeight);
    document.body.classList.remove('drawing', 'selecting');
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
}


const dimensionsLabel = document.getElementById('dimensions-label');

function updateDimensions(w, h) {
    if (dimensionsLabel) {
        // Show physical pixel dimensions (what the final image will actually be)
        const sx = state.scaleX != null ? state.scaleX : state.dpr;
        const sy = state.scaleY != null ? state.scaleY : state.dpr;
        dimensionsLabel.textContent = `${Math.round(w * sx)} x ${Math.round(h * sy)}`;
    }
}

window.addEventListener('mousedown', (e) => {
    if (e.target.closest('.toolbar')) return;
    if (e.target.closest('#text-input-container')) {
        if (e.target === textDragHandle) {
            state.isDraggingText = true;
            const r = textInputContainer.getBoundingClientRect();
            state.dragOffX = e.clientX - r.left; state.dragOffY = e.clientY - r.top;
        }
        return;
    }
    if (state.selectionRect) {
        if (e.target.classList.contains('resize-handle')) {
            state.isResizing = true; state.activeHandle = e.target.dataset.handle;
            const b = selectionBox.getBoundingClientRect();
            state.resizeStartRect = { left: b.left, top: b.top, width: b.width, height: b.height };
            state.startX = e.clientX; state.startY = e.clientY;
            toolbar.style.display = 'none';
            document.body.classList.add('selecting');
            return;
        }
        if (state.activeTool) {
            const r = state.selectionRect;
            if (e.clientX < r.x || e.clientX > r.x + r.w || e.clientY < r.y || e.clientY > r.y + r.h) return;

            if (state.activeTool === 'text') {
                textInputContainer.style.left = e.clientX + 'px'; textInputContainer.style.top = (e.clientY - 20) + 'px';
                textInputContainer.style.display = 'flex'; textInputContainer.classList.remove('hidden');
                textInput.style.width = '200px'; textInput.style.height = 'auto'; // Reset size
                setTimeout(() => { textInput.focus(); adjustTextArea(); }, 0);
                return;
            }

            saveState();
            state.isDrawing = true; state.startX = e.clientX; state.startY = e.clientY;
            lastBlurX = state.startX; lastBlurY = state.startY; // reset so a click (no drag) never commits a stale blur rect
            const sx = state.scaleX != null ? state.scaleX : state.dpr;
            const sy = state.scaleY != null ? state.scaleY : state.dpr;
            
            // Set drawing color immediately from state
            drawCtx.strokeStyle = drawCtx.fillStyle = state.selectedColor;

            if (state.activeTool === 'pen') { drawCtx.beginPath(); drawCtx.moveTo(state.startX * sx, state.startY * sy); }
            else state.savedImageData = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
            return;
        }
        if (e.target === selectionBox) {
            state.isMoving = true;
            const r = selectionBox.getBoundingClientRect();
            state.dragOffX = e.clientX - r.left; state.dragOffY = e.clientY - r.top;
            toolbar.style.display = 'none';
            return;
        }
    }
    if (!state.activeTool) {
        window.api.claimCaptureMonitor(); // new selection → clear other monitors' selections
        resetUI(); state.isSelecting = true;
        document.body.classList.add('selecting');
        // overlay-canvas will update in real-time via drawOverlay() in mousemove
        state.startX = e.clientX; state.startY = e.clientY;
        selectionBox.style.width = selectionBox.style.height = '0px';
        selectionBox.style.left = state.startX + 'px'; selectionBox.style.top = state.startY + 'px';
        selectionBox.style.display = 'block'; selectionBox.classList.remove('hidden');
        updateDimensions(0, 0);
    }
});

function adjustTextArea() {
    textInput.style.width = '200px';
    textInput.style.width = Math.max(200, Math.min(800, textInput.scrollWidth)) + 'px';
    textInput.style.height = 'auto';
    textInput.style.height = textInput.scrollHeight + 'px';
}
textInput.addEventListener('input', adjustTextArea);

window.addEventListener('mousemove', (e) => {
    if (state.isDraggingText) {
        const r = state.selectionRect;
        let x = Math.max(r.x, Math.min(e.clientX - state.dragOffX, r.x + r.w - textInputContainer.offsetWidth));
        let y = Math.max(r.y, Math.min(e.clientY - state.dragOffY, r.y + r.h - textInputContainer.offsetHeight));
        textInputContainer.style.left = x + 'px'; textInputContainer.style.top = y + 'px';
    } else if (state.isResizing) {
        let dx = e.clientX - state.startX, dy = e.clientY - state.startY;
        let { left, top, width, height } = state.resizeStartRect;
        if (state.activeHandle.includes('e')) width += dx;
        if (state.activeHandle.includes('s')) height += dy;
        if (state.activeHandle.includes('w')) { left += dx; width -= dx; }
        if (state.activeHandle.includes('n')) { top += dy; height -= dy; }
        if (width < 20) { if (state.activeHandle.includes('w')) left = state.resizeStartRect.left + state.resizeStartRect.width - 20; width = 20; }
        if (height < 20) { if (state.activeHandle.includes('n')) top = state.resizeStartRect.top + state.resizeStartRect.height - 20; height = 20; }
        selectionBox.style.width = width + 'px'; selectionBox.style.height = height + 'px';
        selectionBox.style.left = left + 'px'; selectionBox.style.top = top + 'px';
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
        selectionBox.style.width = w + 'px';
        selectionBox.style.height = h + 'px';
        selectionBox.style.left = x + 'px';
        selectionBox.style.top = y + 'px';
        updateDimensions(w, h);
        drawOverlay(x, y, w, h);
    } else if (state.isDrawing) {
        const sx = state.scaleX != null ? state.scaleX : state.dpr;
        const sy = state.scaleY != null ? state.scaleY : state.dpr;
        const scale = (sx + sy) / 2;
        drawCtx.save();

        // Enforce drawing color from state inside the save/restore block
        drawCtx.strokeStyle = drawCtx.fillStyle = state.selectedColor;
        drawCtx.lineWidth = 3 * scale;
        drawCtx.font = (20 * scale) + "px Arial";

        const cp = new Path2D();
        cp.rect(state.selectionRect.x * sx, state.selectionRect.y * sy, state.selectionRect.w * sx, state.selectionRect.h * sy);
        drawCtx.clip(cp);

        if (state.activeTool === 'pen') {
            drawCtx.beginPath(); drawCtx.moveTo(state.startX * sx, state.startY * sy);
            drawCtx.lineTo(e.clientX * sx, e.clientY * sy); drawCtx.stroke();
            state.startX = e.clientX; state.startY = e.clientY;
        } else if (state.activeTool === 'blur') {
            lastBlurX = e.clientX; lastBlurY = e.clientY;
            let w = e.clientX - state.startX, h = e.clientY - state.startY;
            if (Math.abs(w) > 5 && Math.abs(h) > 5) {
                const now = performance.now();
                // Throttle the heavy blur recompute to ~60fps; on skipped frames keep
                // the previous preview (no clear) so it doesn't flicker.
                if (now - lastBlurTime >= 16) {
                    lastBlurTime = now;
                    drawCtx.putImageData(state.savedImageData, 0, 0);
                    applyBlur(Math.min(state.startX, e.clientX), Math.min(state.startY, e.clientY), Math.abs(w), Math.abs(h));
                }
            } else {
                drawCtx.putImageData(state.savedImageData, 0, 0);
            }
        } else {
            drawCtx.putImageData(state.savedImageData, 0, 0);
            let w = e.clientX - state.startX, h = e.clientY - state.startY;
            if (e.shiftKey && (state.activeTool === 'rect' || state.activeTool === 'circle')) {
                const s = Math.max(Math.abs(w), Math.abs(h));
                w = w < 0 ? -s : s; h = h < 0 ? -s : s;
            }
            if (state.activeTool === 'rect') drawCtx.strokeRect(state.startX * sx, state.startY * sy, w * sx, h * sy);
            else if (state.activeTool === 'circle') {
                drawCtx.beginPath(); drawCtx.ellipse((state.startX + w / 2) * sx, (state.startY + h / 2) * sy, Math.abs(w / 2) * sx, Math.abs(h / 2) * sy, 0, 0, 2 * Math.PI);
                drawCtx.stroke();
            } else if (state.activeTool === 'arrow') drawArrow(drawCtx, state.startX * sx, state.startY * sy, e.clientX * sx, e.clientY * sy, scale);
        }
        drawCtx.restore();
    }
});

window.addEventListener('mouseup', () => {
    if (state.isResizing || state.isMoving || state.isSelecting) {
        const r = selectionBox.getBoundingClientRect();
        if (state.isSelecting && (r.width < 10 || r.height < 10)) { resetUI(); return; }
        state.selectionRect = { x: r.left, y: r.top, w: r.width, h: r.height };
        showToolbar(r);
    }
    // Blur is throttled during drag; force the final (release) rectangle so the
    // committed/exported blur is never a stale frame.
    if (state.isDrawing && state.activeTool === 'blur' && state.savedImageData && state.selectionRect &&
        Math.abs(lastBlurX - state.startX) > 5 && Math.abs(lastBlurY - state.startY) > 5) {
        const sx = state.scaleX != null ? state.scaleX : state.dpr;
        const sy = state.scaleY != null ? state.scaleY : state.dpr;
        drawCtx.save();
        const cp = new Path2D();
        cp.rect(state.selectionRect.x * sx, state.selectionRect.y * sy, state.selectionRect.w * sx, state.selectionRect.h * sy);
        drawCtx.clip(cp);
        drawCtx.putImageData(state.savedImageData, 0, 0);
        applyBlur(Math.min(state.startX, lastBlurX), Math.min(state.startY, lastBlurY), Math.abs(lastBlurX - state.startX), Math.abs(lastBlurY - state.startY));
        drawCtx.restore();
    }
    state.isDraggingText = state.isResizing = state.isMoving = state.isSelecting = state.isDrawing = false;
    document.body.classList.remove('selecting');
});

function showToolbar(r) {
    toolbar.style.display = 'flex';
    let t = r.bottom + 10;
    // Calculate preferred left position (aligned to right of selection, or left if that's safer?)
    // Original logic was max(left, right - width). We keep that but clamp it.
    let l = Math.max(r.left, r.right - toolbar.offsetWidth);

    // Ensure it doesn't go off the right edge
    if (l + toolbar.offsetWidth > window.innerWidth) {
        l = window.innerWidth - toolbar.offsetWidth - 10;
    }
    // Ensure it doesn't go off the left edge
    if (l < 10) l = 10;

    if (t + toolbar.offsetHeight > window.innerHeight) t = r.top - toolbar.offsetHeight - 10;
    if (t < 10) t = 10; // Extra safety

    toolbar.style.top = t + 'px';

    // Calculate right position to anchor it
    const rightPos = window.innerWidth - (l + toolbar.offsetWidth);
    toolbar.style.left = 'auto';
    toolbar.style.right = rightPos + 'px';
}

function drawArrow(c, fx, fy, tx, ty, scale) {
    const hl = 10 * scale, a = Math.atan2(ty - fy, tx - fx);
    c.beginPath(); c.moveTo(fx, fy); c.lineTo(tx, ty);
    c.lineTo(tx - hl * Math.cos(a - Math.PI / 6), ty - hl * Math.sin(a - Math.PI / 6));
    c.moveTo(tx, ty); c.lineTo(tx - hl * Math.cos(a + Math.PI / 6), ty - hl * Math.sin(a + Math.PI / 6));
    c.stroke();
}

function applyBlur(x, y, w, h) {
    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    const cw = Math.round(w * sx);
    const ch = Math.round(h * sy);
    if (cw < 1 || ch < 1) return;

    const scale = (sx + sy) / 2;
    const pixelSize = Math.max(2, Math.floor(10 * scale));

    // Pixelate via downscale→upscale: drawing the region into a canvas 1/pixelSize the
    // size averages each block (GPU box filter), and drawing it back up with smoothing
    // off re-expands the blocks. Same visual as the old per-pixel averaging loop, but
    // it's two drawImage calls instead of a JS loop over every pixel (no readback).
    const dw = Math.max(1, Math.round(cw / pixelSize));
    const dh = Math.max(1, Math.round(ch / pixelSize));
    if (!blurTempCanvas) blurTempCanvas = document.createElement('canvas');
    const tempCanvas = blurTempCanvas;
    tempCanvas.width = dw;
    tempCanvas.height = dh;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.imageSmoothingEnabled = true; // downscale = average within each block

    tempCtx.drawImage(canvas, x * sx, y * sy, cw, ch, 0, 0, dw, dh);
    tempCtx.drawImage(drawCanvas, x * sx, y * sy, cw, ch, 0, 0, dw, dh);

    drawCtx.save();
    drawCtx.setTransform(1, 0, 0, 1, 0, 0);
    drawCtx.imageSmoothingEnabled = false; // upscale = hard-edged blocks
    drawCtx.drawImage(tempCanvas, 0, 0, dw, dh, x * sx, y * sy, cw, ch);
    drawCtx.restore();
}

document.querySelectorAll('.tool-btn').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tool;
    const isActive = state.activeTool === t;
    if (state.activeTool === 'text') { textInputContainer.style.display = 'none'; textInput.value = ''; }
    state.activeTool = isActive ? null : t;
    document.body.classList.toggle('drawing', !isActive);
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    if (!isActive) b.classList.add('active');
}));

// The screen layer is always opaque (it's a screenshot), so an all-transparent crop means
// the capture never made it onto the canvas. macOS pastes that as a solid black rectangle,
// so it must never reach the clipboard.
function isBlankCrop(tctx, w, h) {
    try {
        const pts = [[w >> 1, h >> 1], [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
        return pts.every(([x, y]) => tctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data[3] === 0);
    } catch (e) {
        return false; // readback can fail on exotic GPUs — don't block the copy over it
    }
}

function getFinalImage() {
    if (!state.selectionRect) return null;
    // Repaint from the retained capture if anything cleared the screen layer since it landed.
    if (!screenPainted) paintScreen();
    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    const r = state.selectionRect;

    // Crop at NATIVE physical pixels. clipboard.writeImage emits a DIB sized by
    // (pixels / nativeImage.scaleFactor); snip-copy-v2 uses scaleFactor 1.0, so the
    // pasted/saved image is exactly cropW x cropH regardless of which monitor or DPI
    // captured it (matches Windows Snipping Tool). No primary-display compensation.
    const cropW = Math.round(r.w * sx);
    const cropH = Math.round(r.h * sy);

    const tc = document.createElement('canvas');
    tc.width = cropW;
    tc.height = cropH;
    const tctx = tc.getContext('2d');
    tctx.imageSmoothingEnabled = false;

    tctx.drawImage(canvas, r.x * sx, r.y * sy, cropW, cropH, 0, 0, cropW, cropH);
    tctx.drawImage(drawCanvas, r.x * sx, r.y * sy, cropW, cropH, 0, 0, cropW, cropH);

    if (isBlankCrop(tctx, cropW, cropH)) {
        throw new Error('Seçilen alanda ekran görüntüsü yok — kopyalansaydı siyah yapışırdı. ESC ile kapatıp tekrar deneyin.');
    }

    return tc.toDataURL('image/png');
}

// Interacting buttons setup...
const buttons = {
    'btn-close': () => window.api.closeSnipper(),
    'btn-copy': () => {
        const d = safeGetImage();
        if (d) {
            window.api.sendDebugLog('Renderer: Sending Copy Request (PNG Quality)');
            window.api.sendCopyImage(d);
        }
    },
    'btn-save': () => { const d = safeGetImage(); if (d) window.api.sendSaveImage(d); },
    'btn-undo': () => undo()
};

Object.entries(buttons).forEach(([id, action]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        try {
            action();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    });
});

function safeGetImage() {
    try {
        const img = getFinalImage();
        if (!img) {
            alert('Selection empty! Please draw a box first.');
            return null;
        }
        return img;
    } catch (e) {
        alert('Resim oluşturulamadı: ' + e.message);
        return null;
    }
}

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation(); const v = textInput.value.trim();
        if (v) {
            saveState();
            const sx = state.scaleX != null ? state.scaleX : state.dpr;
            const sy = state.scaleY != null ? state.scaleY : state.dpr;
            const scale = (sx + sy) / 2;
            drawCtx.save();
            drawCtx.fillStyle = state.selectedColor;
            drawCtx.font = (20 * scale) + "px Arial";
            const cp = new Path2D(); cp.rect(state.selectionRect.x * sx, state.selectionRect.y * sy, state.selectionRect.w * sx, state.selectionRect.h * sy);
            drawCtx.clip(cp);
            const ir = textInput.getBoundingClientRect(); let x = ir.left + 10, y = ir.top + 22;
            v.split('\n').forEach(l => { drawCtx.fillText(l, x * sx, y * sy); y += 24; });
            drawCtx.restore();
        }
        textInputContainer.style.display = 'none'; textInput.value = '';
    } else if (e.key === 'Escape') { e.stopPropagation(); textInputContainer.style.display = 'none'; textInput.value = ''; }
});

// Arrow-key fine-tuning: arrows move the selection 1px, Shift+arrows resize it 1px
// (right/bottom edge), Ctrl multiplies the step by 10. Standard in snipping tools for
// pixel-precise adjustment that's hard with the mouse.
const ARROW_DELTAS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function nudgeSelection(key, shiftKey, ctrlKey) {
    const [dx0, dy0] = ARROW_DELTAS[key];
    const step = ctrlKey ? 10 : 1;
    const dx = dx0 * step, dy = dy0 * step;
    const r = state.selectionRect;

    if (shiftKey) {
        r.w = Math.max(10, Math.min(r.w + dx, window.innerWidth - r.x));
        r.h = Math.max(10, Math.min(r.h + dy, window.innerHeight - r.y));
    } else {
        r.x = Math.max(0, Math.min(r.x + dx, window.innerWidth - r.w));
        r.y = Math.max(0, Math.min(r.y + dy, window.innerHeight - r.h));
    }

    selectionBox.style.left = r.x + 'px';
    selectionBox.style.top = r.y + 'px';
    selectionBox.style.width = r.w + 'px';
    selectionBox.style.height = r.h + 'px';
    drawOverlay(r.x, r.y, r.w, r.h);
    updateDimensions(r.w, r.h);
    showToolbar({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h });
}

document.addEventListener('keydown', (e) => {
    // While typing an annotation, leave undo/copy/close to the textarea (and its own
    // Enter/Escape handler); don't trigger canvas undo, image copy, or window close.
    if (document.activeElement === textInput) return;
    if (e.key === 'Escape') window.api.closeSnipper();
    if (e.ctrlKey && e.key.toLowerCase() === 'z') undo();
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        e.preventDefault(); // Prevent default copy which might fail if nothing focusable
        buttons['btn-copy']();
    }
    // Plain C = color picker: copy the hex code under the loupe crosshair to the
    // clipboard (it also lands in the CopyBoard history). Only while the loupe is
    // visible, so it can't clash with Ctrl+C image copy during annotation.
    if (!e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c' && loupe.style.display === 'block' && loupeHex) {
        e.preventDefault();
        window.api.copyItem(loupeHex);
        loupeFlashText = '✓ Kopyalandı ' + loupeHex;
        loupeFlashUntil = Date.now() + 900;
        loupeLabel.textContent = loupeFlashText;
    }
    // Enter confirms: copy the current selection to the clipboard (same as the ✓/copy button).
    if (e.key === 'Enter' && state.selectionRect) {
        e.preventDefault();
        buttons['btn-copy']();
    }
    if (state.selectionRect && ARROW_DELTAS[e.key]) {
        e.preventDefault(); // keep arrows from scrolling/moving focus
        nudgeSelection(e.key, e.shiftKey, e.ctrlKey);
    }
});

document.querySelectorAll('.color-dot').forEach(d => {
    const selectColor = () => {
        document.querySelectorAll('.color-dot').forEach(dot => dot.classList.remove('active'));
        d.classList.add('active');
        drawCtx.strokeStyle = drawCtx.fillStyle = d.dataset.color;
        state.selectedColor = d.dataset.color;
        // Update selection border color immediately if selection exists
        if (state.selectionRect) {
            const r = state.selectionRect;
            drawOverlay(r.x, r.y, r.w, r.h);
        }
    };
    d.addEventListener('click', selectColor);
    d.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectColor(); }
    });
});

// Color palette toggle
const colorToggle = document.getElementById('color-toggle');
const colorGroup = document.querySelector('.color-group');
colorToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    colorGroup.classList.toggle('collapsed');
    colorGroup.classList.toggle('expanded');
    colorToggle.classList.toggle('active');
});

// ── Loupe (pixel magnifier) ────────────────────────────────────────────────
// Zoomed view of the pixels around the cursor + physical coordinates + the color
// under the crosshair. Shown while picking/adjusting the region (before a selection
// exists, while dragging one out, and while resizing); hidden once the selection is
// settled so it never covers the toolbar/annotation phase.
const LOUPE_SIZE = 120;   // on-screen loupe box (px)
const LOUPE_ZOOM = 4;     // magnification (logical px)

const loupe = document.createElement('div');
loupe.style.cssText = 'position:fixed;width:' + LOUPE_SIZE + 'px;display:none;pointer-events:none;z-index:10000;'
    + 'border:1px solid rgba(255,255,255,0.85);border-radius:10px;overflow:hidden;'
    + 'box-shadow:0 4px 16px rgba(0,0,0,0.5);background:#111;';
const loupeCanvas = document.createElement('canvas');
loupeCanvas.width = LOUPE_SIZE;
loupeCanvas.height = LOUPE_SIZE;
const loupeCtx = loupeCanvas.getContext('2d', { willReadFrequently: true });
const loupeLabel = document.createElement('div');
loupeLabel.style.cssText = 'font:11px Consolas,monospace;color:#fff;background:rgba(0,0,0,0.78);'
    + 'padding:3px 6px;text-align:center;letter-spacing:0.3px;white-space:nowrap;';
const loupeHint = document.createElement('div');
loupeHint.style.cssText = 'font:9px Consolas,monospace;color:rgba(255,255,255,0.55);'
    + 'background:rgba(0,0,0,0.78);padding:0 6px 3px;text-align:center;white-space:nowrap;';
loupeHint.textContent = 'C: rengi kopyala';
loupe.appendChild(loupeCanvas);
loupe.appendChild(loupeLabel);
loupe.appendChild(loupeHint);
document.body.appendChild(loupe);

// Color-picker state: the hex under the crosshair right now, and a short-lived
// "copied" flash shown in the label after pressing C.
let loupeHex = '';
let loupeFlashText = '';
let loupeFlashUntil = 0;

function hideLoupe() { loupe.style.display = 'none'; }

function updateLoupe(cx, cy) {
    // Visible while choosing/adjusting the region; hidden after it settles.
    const relevant = !state.selectionRect || state.isSelecting || state.isResizing;
    if (!relevant || !document.body.classList.contains('ready')) { hideLoupe(); return; }

    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    const srcLogical = LOUPE_SIZE / LOUPE_ZOOM; // logical px shown inside the loupe

    loupeCtx.imageSmoothingEnabled = false;
    loupeCtx.fillStyle = '#111';
    loupeCtx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    loupeCtx.drawImage(
        canvas,
        cx * sx - (srcLogical / 2) * sx, cy * sy - (srcLogical / 2) * sy,
        srcLogical * sx, srcLogical * sy,
        0, 0, LOUPE_SIZE, LOUPE_SIZE
    );

    // Color under the cursor — sampled from the small loupe canvas (cheap readback).
    let hex = '';
    try {
        const p = loupeCtx.getImageData(LOUPE_SIZE / 2, LOUPE_SIZE / 2, 1, 1).data;
        hex = ' #' + [p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* readback can fail on exotic GPUs; label just omits the color */ }
    loupeHex = hex.trim();

    // Center crosshair
    loupeCtx.strokeStyle = 'rgba(255,80,80,0.9)';
    loupeCtx.lineWidth = 1;
    loupeCtx.beginPath();
    loupeCtx.moveTo(LOUPE_SIZE / 2 + 0.5, 0); loupeCtx.lineTo(LOUPE_SIZE / 2 + 0.5, LOUPE_SIZE);
    loupeCtx.moveTo(0, LOUPE_SIZE / 2 + 0.5); loupeCtx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2 + 0.5);
    loupeCtx.stroke();

    loupeLabel.textContent = Date.now() < loupeFlashUntil
        ? loupeFlashText
        : Math.round(cx * sx) + ', ' + Math.round(cy * sy) + hex;

    // Offset from the cursor; flip to the other side near screen edges.
    const OFF = 22, boxH = LOUPE_SIZE + 24;
    let lx = cx + OFF;
    let ly = cy + OFF;
    if (lx + LOUPE_SIZE + 8 > window.innerWidth) lx = cx - OFF - LOUPE_SIZE;
    if (ly + boxH + 8 > window.innerHeight) ly = cy - OFF - boxH;
    loupe.style.left = lx + 'px';
    loupe.style.top = ly + 'px';
    loupe.style.display = 'block';
}

window.addEventListener('mousemove', (e) => updateLoupe(e.clientX, e.clientY), { passive: true });
window.addEventListener('mouseup', () => { if (state.selectionRect) hideLoupe(); });

