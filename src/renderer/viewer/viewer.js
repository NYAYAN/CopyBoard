const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
// Large screenshot viewer: shows one full-resolution capture in its own resizable
// window. The main process sends 'viewer-list' (filmstrip thumbnails) and
// 'viewer-image' (data URL + meta) on open and on every navigation.
//
// The stage also carries an annotation layer: a canvas parked on top of the rendered
// image at the image's NATIVE pixel size, so what gets copied is marked up at full
// resolution rather than at whatever size the window happens to be. Annotations are
// kept as vector ops, not pixels — that's what makes undo cheap and lets each image
// keep its own drawing while the user pages through the gallery.

const stage = document.getElementById('viewer-stage');
const img = document.getElementById('viewer-img');
const canvas = document.getElementById('viewer-canvas');
const ctx = canvas.getContext('2d');
const title = document.getElementById('viewer-title');
const strip = document.getElementById('viewer-strip');
const prevBtn = document.getElementById('nav-prev');
const nextBtn = document.getElementById('nav-next');
const drawBtn = document.getElementById('draw-btn');
const drawbar = document.getElementById('drawbar');
const toolGroup = document.getElementById('tool-group');
const colorGroup = document.getElementById('color-group');
const sizeGroup = document.getElementById('size-group');
const undoBtn = document.getElementById('undo-btn');
const clearBtn = document.getElementById('clear-btn');
const drawFrame = document.getElementById('draw-frame');
const textWrap = document.getElementById('text-wrap');
const textInput = document.getElementById('text-input');
const cropBar = document.getElementById('crop-bar');
const copyLabel = document.getElementById('copy-label');

let shotId = null;
let stripKey = ''; // id fingerprint of the rendered strip — skip rebuilds when unchanged

// Committed shapes are rasterised once onto an offscreen canvas, so dragging a shape
// only repaints that shape instead of the whole stack.
const base = document.createElement('canvas');
const bctx = base.getContext('2d');
const shapesById = new Map(); // shot id -> shapes, so ←/→ doesn't throw a drawing away

const COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#32d74b', '#0a84ff', '#ffffff', '#000000'];
const SIZES = { thin: 2, med: 3.5, thick: 6 };
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const ACCENT = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8957e5';
const MIN_CROP = 5; // image px — anything smaller is a click, not a selection

let shapes = [];    // committed ops for the image on screen
let active = null;  // the op under the cursor mid-drag
let crop = null;    // [x, y, w, h] in image px: copy this region instead of the whole shot
let drawMode = false;
let tool = 'pen';
let color = COLORS[0];
let sizeKey = 'med';
let textAt = null;  // image-space anchor of the open text box

function fmtTime(iso) {
    try {
        return new Date(iso).toLocaleString('tr-TR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    } catch (e) {
        return '';
    }
}

// PNG weight on disk, in the same decimal notation as the rest of the UI.
function fmtSize(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    // Compare the ROUNDED value, or 1048575 B prints as "1024 KB".
    if (Math.round(kb) < 1024) return Math.round(kb) + ' KB';
    return (kb / 1024).toFixed(1).replace('.', ',') + ' MB';
}

// Title bar: dimensions and file size as chips (what you'd actually check before
// pasting), then the capture time and the position in the gallery.
function renderTitle(data) {
    title.innerHTML = '';
    const part = (cls, text) => {
        if (!text) return;
        const el = document.createElement('span');
        el.className = cls;
        el.textContent = text;
        title.appendChild(el);
    };
    part('ti-chip ti-dim', `${data.w} × ${data.h}`);
    part('ti-chip', fmtSize(data.size));
    part('ti-time', fmtTime(data.timestamp));
    if (data.pos && data.total) part('ti-chip ti-pos', `${data.pos} / ${data.total}`);
}

// ── Zoom ─────────────────────────────────────────────────────────────────────
// zoom === 0 means "fit the window" (the CSS does it); any other value is an explicit
// scale, applied as a pixel width so the stage can scroll around it. The annotation
// canvas needs no special handling — layoutCanvas() tracks the image's rendered box,
// whatever produced it.
const ZOOM_MAX = 8;
let zoom = 0;

// What fit mode is actually showing right now — the floor for zooming out, and the
// number the % readout compares against.
function fitScale() {
    if (!img.naturalWidth) return 1;
    return Math.min(1, stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
}

const currentScale = () => (zoom || fitScale());

function applyZoom() {
    if (zoom) {
        stage.classList.add('zoomed');
        img.style.width = Math.round(img.naturalWidth * zoom) + 'px';
        img.style.height = 'auto';
    } else {
        stage.classList.remove('zoomed');
        img.style.width = '';
        img.style.height = '';
    }
    layoutCanvas();
    paint(); // crop chrome is sized in inverse display scale
    updateZoomChip();
}

// anchor: a viewport point to keep still (the cursor), so zooming goes where you look.
function setZoom(next, anchor) {
    const fit = fitScale();
    // Anything at or below fit snaps back to fit — no dead zone where a "zoom" shows
    // the same thing as fitting but with scrollbars.
    const target = next <= fit * 1.01 ? 0 : Math.min(ZOOM_MAX, next);
    if (target === zoom) return;

    const before = img.getBoundingClientRect();
    const ax = anchor ? anchor.x : before.left + before.width / 2;
    const ay = anchor ? anchor.y : before.top + before.height / 2;
    // Where the anchor sits on the image itself, 0..1
    const fx = before.width ? (ax - before.left) / before.width : 0.5;
    const fy = before.height ? (ay - before.top) / before.height : 0.5;

    zoom = target;
    applyZoom();

    if (zoom) {
        const after = img.getBoundingClientRect();
        stage.scrollLeft += (after.left + fx * after.width) - ax;
        stage.scrollTop += (after.top + fy * after.height) - ay;
        layoutCanvas();
    }
}

// Shown only while the zoom is manual. In fit mode the honest number is "whatever
// fits", and measuring it off the element box reports the box, not the painted image
// (object-fit: contain letterboxes inside it) — a readout that lies is worse than none.
function updateZoomChip() {
    const chip = title.querySelector('.ti-zoom');
    if (!zoom) {
        if (chip) chip.remove();
        return;
    }
    const el = chip || Object.assign(document.createElement('span'), { className: 'ti-chip ti-zoom ti-zoom-on' });
    el.textContent = Math.round(zoom * 100) + '%';
    if (!chip) title.appendChild(el);
}

// Click still toggles the two useful extremes — fit and actual size.
function toggleActualSize(anchor) {
    setZoom(zoom ? 0 : 1, anchor);
}

function updateZoomable() {
    const zoomable = img.naturalWidth > stage.clientWidth || img.naturalHeight > stage.clientHeight;
    stage.classList.toggle('zoomable', zoomable);
}

function markActiveThumb() {
    let current = null;
    strip.querySelectorAll('img').forEach(t => {
        const on = t.dataset.id === shotId;
        t.classList.toggle('active', on);
        if (on) current = t;
    });
    if (current) current.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

// ── Annotation geometry ──────────────────────────────────────────────────────

// Stroke weights are relative to the image's own resolution: a "medium" line has to
// read the same on a 400px snip and on a 4K capture.
function unit() {
    return Math.max(1, Math.min(img.naturalWidth, img.naturalHeight) / 500);
}

function strokeWidth() {
    return SIZES[sizeKey] * unit();
}

// Rendered pixels per image pixel — the text box mirrors the canvas font through it.
function displayScale() {
    const r = img.getBoundingClientRect();
    return img.naturalWidth ? r.width / img.naturalWidth : 1;
}

// Keep the canvas exactly over the rendered image. Offsets are content-relative (the
// stage scrolls when zoomed), so they survive scrolling without being recomputed.
function layoutCanvas() {
    const ir = img.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const box = {
        left: (ir.left - sr.left + stage.scrollLeft) + 'px',
        top: (ir.top - sr.top + stage.scrollTop) + 'px',
        width: ir.width + 'px',
        height: ir.height + 'px'
    };
    Object.assign(canvas.style, box);
    Object.assign(drawFrame.style, box); // the corner brackets track the same box
    layoutCropBar();
}

function pointAt(e) {
    const r = canvas.getBoundingClientRect();
    return [
        (e.clientX - r.left) * (canvas.width / r.width),
        (e.clientY - r.top) * (canvas.height / r.height)
    ];
}

function rectOf(s) {
    return [
        Math.min(s.from[0], s.to[0]), Math.min(s.from[1], s.to[1]),
        Math.abs(s.to[0] - s.from[0]), Math.abs(s.to[1] - s.from[1])
    ];
}

function drawArrow(c, s) {
    const [fx, fy] = s.from, [tx, ty] = s.to;
    const hl = Math.max(10, s.size * 3.5), a = Math.atan2(ty - fy, tx - fx);
    c.beginPath();
    c.moveTo(fx, fy);
    c.lineTo(tx, ty);
    c.lineTo(tx - hl * Math.cos(a - Math.PI / 6), ty - hl * Math.sin(a - Math.PI / 6));
    c.moveTo(tx, ty);
    c.lineTo(tx - hl * Math.cos(a + Math.PI / 6), ty - hl * Math.sin(a + Math.PI / 6));
    c.stroke();
}

// Pixelating would mean a readback per frame; a heavy gaussian of the source image,
// clipped to the rect, hides text just as well and costs nothing to re-render. Drawn
// twice so the blur's own soft edges stay fully opaque.
function drawBlur(c, x, y, w, h) {
    if (w < 2 || h < 2) return;
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.filter = `blur(${Math.max(6, Math.round(Math.min(w, h) / 5))}px)`;
    c.drawImage(img, 0, 0, base.width, base.height);
    c.drawImage(img, 0, 0, base.width, base.height);
    c.filter = 'none';
}

function drawShape(c, s) {
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = c.fillStyle = s.color;
    c.lineWidth = s.size;

    if (s.tool === 'pen') {
        c.beginPath();
        s.points.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
        if (s.points.length === 1) c.lineTo(s.points[0][0] + 0.1, s.points[0][1]); // a click leaves a dot
        c.stroke();
    } else if (s.tool === 'text') {
        const px = Math.round(s.size * 4);
        c.font = px + 'px ' + FONT_STACK;
        c.textBaseline = 'top';
        s.text.split('\n').forEach((line, i) => c.fillText(line, s.x, s.y + i * px * 1.25));
    } else {
        const [x, y, w, h] = rectOf(s);
        if (s.tool === 'rect') c.strokeRect(x, y, w, h);
        else if (s.tool === 'circle') {
            c.beginPath();
            c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
            c.stroke();
        } else if (s.tool === 'arrow') drawArrow(c, s);
        else if (s.tool === 'blur') drawBlur(c, x, y, w, h);
    }
    c.restore();
}

// ── Crop region ──────────────────────────────────────────────────────────────

// Chrome (border, readout) is drawn in image pixels but has to LOOK the same size
// whatever the zoom, so everything is scaled by the inverse of the display scale.
function drawCropOverlay(c, rect) {
    const [x, y, w, h] = rect;
    const px = 1 / displayScale();
    c.save();
    c.fillStyle = 'rgba(0, 0, 0, 0.55)';
    c.beginPath();
    c.rect(0, 0, canvas.width, canvas.height);
    c.rect(x, y, w, h);
    c.fill('evenodd'); // dim everything except the selection
    if (w >= 1 && h >= 1) {
        c.strokeStyle = ACCENT;
        c.lineWidth = 2 * px;
        c.strokeRect(x, y, w, h);

        const label = `${Math.round(w)} × ${Math.round(h)}`;
        const fs = 12 * px, pad = 5 * px, bh = fs * 1.7;
        c.font = fs + 'px ' + FONT_STACK;
        const bw = c.measureText(label).width + pad * 2;
        const lx = Math.min(x, canvas.width - bw);
        const ly = y - bh - 3 * px < 0 ? y + 3 * px : y - bh - 3 * px; // flip inside at the top edge
        c.fillStyle = 'rgba(0, 0, 0, 0.75)';
        c.fillRect(lx, ly, bw, bh);
        c.fillStyle = '#fff';
        c.textBaseline = 'middle';
        c.fillText(label, lx + pad, ly + bh / 2);
    }
    c.restore();
}

function rectFromDrag(s) {
    const [x, y, w, h] = rectOf(s);
    // The pointer keeps reporting past the image while captured — keep the region inside.
    const x0 = Math.round(Math.max(0, Math.min(x, canvas.width)));
    const y0 = Math.round(Math.max(0, Math.min(y, canvas.height)));
    return [x0, y0, Math.round(Math.min(w, canvas.width - x0)), Math.round(Math.min(h, canvas.height - y0))];
}

function setCrop(rect) {
    crop = rect && rect[2] >= MIN_CROP && rect[3] >= MIN_CROP ? rect : null;
    copyLabel.textContent = crop ? t('Alanı Kopyala') : t('Kopyala');
    layoutCropBar();
    paint();
}

// Park the action bar just under the selection, right-aligned, always inside the image.
function layoutCropBar() {
    if (!crop) { cropBar.hidden = true; return; }
    cropBar.hidden = false;
    const [x, y, w, h] = crop;
    const s = displayScale();
    const ir = img.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const ox = ir.left - sr.left + stage.scrollLeft;
    const oy = ir.top - sr.top + stage.scrollTop;
    const gap = 8;
    let left = ox + (x + w) * s - cropBar.offsetWidth;
    let top = oy + (y + h) * s + gap;
    if (top + cropBar.offsetHeight > oy + ir.height) top = oy + (y + h) * s - cropBar.offsetHeight - gap;
    cropBar.style.left = Math.max(ox, Math.min(left, ox + ir.width - cropBar.offsetWidth)) + 'px';
    cropBar.style.top = Math.max(oy, top) + 'px';
}

// Visible layer = everything committed + whatever is being dragged right now.
function paint() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    if (active && active.tool !== 'crop') drawShape(ctx, active);
    const region = active && active.tool === 'crop' ? rectFromDrag(active) : crop;
    if (region) drawCropOverlay(ctx, region);
}

// Rebuild the committed layer from the op list (undo, clear, image swap).
function repaint() {
    bctx.clearRect(0, 0, base.width, base.height);
    shapes.forEach(s => drawShape(bctx, s));
    undoBtn.disabled = clearBtn.disabled = shapes.length === 0;
    paint();
}

// ── Drawing input ────────────────────────────────────────────────────────────

canvas.addEventListener('pointerdown', (e) => {
    if (!drawMode || e.button !== 0) return;
    const p = pointAt(e);
    // preventDefault keeps the default focus shift from immediately blurring (and so
    // closing) the text box we're about to open.
    if (tool === 'text') { e.preventDefault(); openTextBox(p, e); return; }
    commitText();
    if (tool === 'crop') cropBar.hidden = true; // out of the way until the drag lands
    canvas.setPointerCapture(e.pointerId);
    active = tool === 'pen'
        ? { tool, color, size: strokeWidth(), points: [p] }
        : { tool, color, size: strokeWidth(), from: p, to: p };
    paint();
});

canvas.addEventListener('pointermove', (e) => {
    if (!active) return;
    let p = pointAt(e);
    if (active.points) {
        active.points.push(p);
    } else {
        // Shift locks a square / circle, same as the snipper.
        if (e.shiftKey && (active.tool === 'rect' || active.tool === 'circle')) {
            const dx = p[0] - active.from[0], dy = p[1] - active.from[1];
            const side = Math.max(Math.abs(dx), Math.abs(dy));
            p = [active.from[0] + (dx < 0 ? -side : side), active.from[1] + (dy < 0 ? -side : side)];
        }
        active.to = p;
    }
    paint();
});

function endStroke() {
    if (!active) return;
    const s = active;
    active = null;
    // Crop isn't an annotation — it never lands in `shapes`. A drag too small to be a
    // real selection reads as a click, which drops the region.
    if (s.tool === 'crop') { setCrop(rectFromDrag(s)); return; }
    // A stray click with a drag tool would commit an invisible zero-size shape.
    if (s.from && Math.abs(s.to[0] - s.from[0]) < 3 && Math.abs(s.to[1] - s.from[1]) < 3) { paint(); return; }
    shapes.push(s);
    repaint();
}

canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// ── Text tool ────────────────────────────────────────────────────────────────

function openTextBox(p, e) {
    commitText();
    const size = strokeWidth();
    textAt = { x: p[0], y: p[1], size, color };
    const sr = stage.getBoundingClientRect();
    textInput.value = '';
    textInput.style.fontSize = Math.max(10, Math.round(size * 4 * displayScale())) + 'px';
    textInput.style.color = color;
    textInput.style.width = 'auto';
    textInput.style.height = 'auto';
    textWrap.style.left = (e.clientX - sr.left + stage.scrollLeft) + 'px';
    textWrap.style.top = (e.clientY - sr.top + stage.scrollTop) + 'px';
    textWrap.hidden = false;
    textInput.focus();
}

function commitText() {
    if (!textAt) return;
    const at = textAt;
    const value = textInput.value.replace(/\s+$/, '');
    textAt = null;
    textWrap.hidden = true;
    if (!value) return;
    shapes.push({ tool: 'text', color: at.color, size: at.size, x: at.x, y: at.y, text: value });
    repaint();
}

function cancelText() {
    textAt = null;
    textWrap.hidden = true;
}

// Grow with the content — nothing soft-wraps (wrap="off"), so the box matches the
// canvas render line for line.
textInput.addEventListener('input', () => {
    textInput.style.width = '0px';
    textInput.style.width = (textInput.scrollWidth + 12) + 'px';
    textInput.style.height = 'auto';
    textInput.style.height = textInput.scrollHeight + 'px';
});

textInput.addEventListener('blur', commitText);

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
});

// ── Toolbar wiring ───────────────────────────────────────────────────────────

function selectIn(group, btn) {
    group.querySelectorAll('.active').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

function setDrawMode(on) {
    if (!on) { commitText(); setCrop(null); } // no tools open, no lingering selection
    drawMode = on;
    drawBtn.classList.toggle('active', on);
    drawbar.hidden = !on;
    drawFrame.hidden = !on;
    stage.classList.toggle('drawing', on);
    updateZoomable(); // the drawbar took a strip of the stage's height
    layoutCanvas();
}

drawBtn.addEventListener('click', () => setDrawMode(!drawMode));

toolGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool');
    if (!btn) return;
    commitText();
    tool = btn.dataset.tool;
    selectIn(toolGroup, btn);
});

sizeGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.size');
    if (!btn) return;
    sizeKey = btn.dataset.size;
    selectIn(sizeGroup, btn);
});

COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' active' : '');
    b.style.background = c; // via the CSSOM: the CSP blocks style ATTRIBUTES, not this
    b.title = c;
    b.setAttribute('aria-label', 'Renk ' + c);
    b.addEventListener('click', () => { color = c; selectIn(colorGroup, b); });
    colorGroup.appendChild(b);
});

const customSwatch = document.createElement('label');
customSwatch.className = 'swatch custom';
customSwatch.title = t('Özel renk');
const customInput = document.createElement('input');
customInput.type = 'color';
customInput.value = '#8957e5';
customInput.addEventListener('input', () => { color = customInput.value; selectIn(colorGroup, customSwatch); });
customSwatch.addEventListener('click', () => { color = customInput.value; selectIn(colorGroup, customSwatch); });
customSwatch.appendChild(customInput);
colorGroup.appendChild(customSwatch);

function undo() {
    if (!shapes.length) return;
    shapes.pop();
    repaint();
}

undoBtn.addEventListener('click', undo);
clearBtn.addEventListener('click', () => {
    if (!shapes.length) return;
    shapes.length = 0; // mutate: shapesById holds this very array
    repaint();
});

// ── Copy ─────────────────────────────────────────────────────────────────────

// Untouched image → let the main process copy the original PNG straight off disk.
// Marked up or cropped → flatten image + annotations over the chosen region instead.
function copyCurrent() {
    commitText();
    if (!shotId) return;
    if (!shapes.length && !crop) { window.api.copyScreenshot(shotId); return; }
    const [x, y, w, h] = crop || [0, 0, base.width, base.height];
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');
    octx.drawImage(img, x, y, w, h, 0, 0, w, h);
    octx.drawImage(base, x, y, w, h, 0, 0, w, h);
    window.api.viewerCopyAnnotated(out.toDataURL('image/png'));
    // The edit is done and filed: main will swap the viewer to the new copy, so drop the
    // tools (and the selection with them) rather than hanging them over a fresh image.
    setDrawMode(false);
}

// ── Main-process traffic ─────────────────────────────────────────────────────

window.api.onViewerList((list) => {
    const key = (list || []).map(s => s.id).join(',');
    if (key === stripKey) { markActiveThumb(); return; } // same set — keep DOM, avoid flicker
    stripKey = key;
    strip.innerHTML = '';
    (list || []).forEach(s => {
        const thumb = document.createElement('img');
        thumb.src = s.thumb;
        thumb.alt = t('küçük resim');
        thumb.dataset.id = s.id;
        thumb.addEventListener('click', () => window.api.viewerSelect(s.id));
        strip.appendChild(thumb);
    });
    markActiveThumb();
});

window.api.onViewerImage((data) => {
    // The same shot is re-sent whenever its gallery position shifts (an annotated copy
    // adds an entry). Only a genuinely different image resets the drawing.
    if (data.id !== shotId) {
        shotId = data.id;
        stage.classList.remove('zoomed');
        cancelText();
        setCrop(null);
        active = null;
        shapes = shapesById.get(shotId) || [];
        shapesById.set(shotId, shapes);
        img.src = data.dataUrl;
    }

    renderTitle(data);

    prevBtn.disabled = !(data.pos > 1);
    nextBtn.disabled = !(data.pos && data.total && data.pos < data.total);
    markActiveThumb();
});

img.addEventListener('load', () => {
    // Assigning width/height wipes the bitmap, so the ops are replayed right after.
    canvas.width = base.width = img.naturalWidth;
    canvas.height = base.height = img.naturalHeight;
    zoom = 0; // a new image starts fitted
    applyZoom();
    updateZoomable();
    layoutCanvas();
    repaint();
});

window.addEventListener('resize', () => { updateZoomable(); layoutCanvas(); updateZoomChip(); });
// Safety net for anything the explicit calls miss. Kept in a variable on purpose:
// an observer nobody holds a reference to gets garbage-collected and silently stops.
const imgObserver = new ResizeObserver(layoutCanvas);
imgObserver.observe(img);

// Click toggles fit ↔ actual size, anchored where you clicked. Not while drawing —
// the canvas owns the pointer then.
img.addEventListener('click', (e) => toggleActualSize({ x: e.clientX, y: e.clientY }));

// Trackpad pinch arrives as a wheel event with ctrlKey set; Cmd/Ctrl+wheel is the
// mouse equivalent. A plain wheel keeps scrolling the zoomed image.
stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const step = Math.exp(-e.deltaY * 0.01); // smooth, and symmetric in both directions
    setZoom(currentScale() * step, { x: e.clientX, y: e.clientY });
}, { passive: false });

prevBtn.addEventListener('click', () => window.api.viewerNav('prev'));
nextBtn.addEventListener('click', () => window.api.viewerNav('next'));

document.getElementById('copy-btn').addEventListener('click', copyCurrent);
document.getElementById('crop-copy').addEventListener('click', copyCurrent);
document.getElementById('crop-cancel').addEventListener('click', () => setCrop(null));
document.getElementById('folder-btn').addEventListener('click', () => {
    if (shotId) window.api.showScreenshotFile(shotId);
});
// Main decides what the viewer lands on afterwards: the next shot, or the window closes
// when that was the last one.
document.getElementById('delete-btn').addEventListener('click', () => {
    if (shotId) window.api.deleteScreenshot(shotId);
});
document.getElementById('close-btn').addEventListener('click', () => window.api.viewerClose());

document.addEventListener('keydown', (e) => {
    if (e.target === textInput || e.target === customInput) return; // the text box owns its keys
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copyCurrent(); }
    // Zoom: the shortcuts every image viewer has. '=' is what Cmd++ reports unshifted.
    else if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(currentScale() * 1.25); }
    else if (mod && e.key === '-') { e.preventDefault(); setZoom(currentScale() / 1.25); }
    else if (mod && e.key === '0') { e.preventDefault(); setZoom(0); }
    else if (mod && e.key === '1') { e.preventDefault(); setZoom(1); }
    // Esc unwinds one step at a time — closing the window would take the drawing with it.
    else if (e.key === 'Escape') {
        if (crop) setCrop(null);
        else if (drawMode) setDrawMode(false);
        else window.api.viewerClose();
    }
    else if (e.key === 'ArrowLeft') window.api.viewerNav('prev');
    else if (e.key === 'ArrowRight') window.api.viewerNav('next');
});
