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
const zoomBtn = document.getElementById('zoom-btn');
const zoomLabel = document.getElementById('zoom-label');
const zoomOutBtn = document.getElementById('zoom-out');
const zoomInBtn = document.getElementById('zoom-in');
const minBtn = document.getElementById('min-btn');
const maxBtn = document.getElementById('max-btn');

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
const ZOOM_MIN = 0.1;
const ZOOM_STEP = 1.25;
let zoom = 0;

// The stage's own gutter, taken off the element rather than repeated here. clientWidth
// counts padding, so every "how much room is there" question has to subtract it — get
// that wrong and fit mode reports a scale the picture cannot actually reach.
const STAGE_PAD = parseFloat(getComputedStyle(stage).paddingTop) || 0;
const stageRoom = () => ({
    w: stage.clientWidth - STAGE_PAD * 2,
    h: stage.clientHeight - STAGE_PAD * 2
});

// What fit mode is actually showing right now — the number the % readout compares
// against, and the scale the zoom snaps back to when it lands on top of it.
function fitScale() {
    if (!img.naturalWidth) return 1;
    const room = stageRoom();
    return Math.min(1, room.w / img.naturalWidth, room.h / img.naturalHeight);
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
    // Below fit, a click makes the picture BIGGER — the zoom-out cursor would lie.
    stage.classList.toggle('shrunk', !!zoom && zoom < fitScale());
    layoutCanvas();
    paint(); // crop chrome is sized in inverse display scale
    updateZoomLabel();
}

// anchor: a viewport point to keep still (the cursor), so zooming goes where you look.
function setZoom(next, anchor) {
    const fit = fitScale();
    let target;
    if (next === 0) {
        target = 0; // an explicit "fit the window"
    } else {
        const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
        // Landing on fit IS fit: don't leave a scrollable stage showing exactly what
        // fitting shows. Passing through it, in either direction, is allowed.
        target = Math.abs(clamped - fit) < fit * 0.01 ? 0 : clamped;
    }
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

// The header readout. Derived from the scale we asked for, never measured off the
// element box: with object-fit: contain the box can be larger than the painted image,
// and an early cut of this read 124% on an image that was plainly fitted.
function updateZoomLabel() {
    const scale = scaleNow();
    if (zoomingGrid()) {
        // Three things can be true of a grid: every pane fitted (fit is a different
        // percentage in each, so the word IS the readout), every pane on one scale, or —
        // once a single picture has been zoomed on its own — no shared number at all.
        const g = gridZoom();
        zoomLabel.textContent = g === null ? t('Karışık') : g ? Math.round(g * 100) + '%' : t('Sığdır');
        zoomBtn.classList.toggle('on', g !== 0); // lit unless every pane is fitted
    } else {
        zoomLabel.textContent = Math.round(scale * 100) + '%';
        zoomBtn.classList.toggle('on', !!zoom); // lit only while the zoom is the user's
    }
    zoomOutBtn.disabled = scale <= ZOOM_MIN * 1.001;
    zoomInBtn.disabled = scale >= ZOOM_MAX * 0.999;
}

// One zoom control, two things it can be pointed at: the stage's single picture, or every
// pane of the comparison at once. Everything that zooms — the ± buttons, the readout, the
// keys, ctrl+wheel, a click on a picture — goes through these three, so this is the only
// place that has to know which of the two is on screen.
const zoomingGrid = () => cmpState === 'show';
const manualZoom = () => (zoomingGrid() ? (gridZoom() || 0) : zoom);
// Where a ± step starts from in the grid: pane 1, the leftmost one. When the panes hold
// different scales there is no other honest choice, and stepping from it lands them all on
// the same one — which is what the control that moves them together is for.
const scaleNow = () => (zoomingGrid() ? paneScale(picked.find(id => cmpPanes.has(id))) : currentScale());
const zoomTo = (next, anchor) => (zoomingGrid() ? setCompareZoom(next, anchor) : setZoom(next, anchor));

// The buttons act on one picture on the stage and on every pane in the grid, so the
// tooltips are swapped with the mode. Written through t() rather than read off the markup:
// this runs before shared/i18n.js has translated the document.
function setZoomScopeTips(grid) {
    const out = grid ? t('Tümünü uzaklaştır') : t('Uzaklaştır (Ctrl/Cmd −)');
    const zin = grid ? t('Tümünü yakınlaştır') : t('Yakınlaştır (Ctrl/Cmd +)');
    zoomOutBtn.title = zoomOutBtn.ariaLabel = out;
    zoomInBtn.title = zoomInBtn.ariaLabel = zin;
    zoomBtn.title = grid ? t('Tümü: gerçek boyut (%100) — tekrar tıkla: sığdır')
        : t('Gerçek boyut (%100) — tekrar tıkla: sığdır');
}

// Click still toggles the two useful extremes — fit and actual size.
function toggleActualSize(anchor) {
    zoomTo(manualZoom() ? 0 : 1, anchor);
}

// The header button always goes to 1:1 first, whatever the current scale — that's the
// number on it. Only when 1:1 is already on screen does it hand back fit.
function zoomButtonClick() {
    zoomTo(Math.abs(scaleNow() - 1) < 0.005 ? 0 : 1);
}

function updateZoomable() {
    const room = stageRoom();
    stage.classList.toggle('zoomable', img.naturalWidth > room.w || img.naturalHeight > room.h);
}

function markActiveThumb() {
    let current = null;
    strip.querySelectorAll('.strip-item').forEach(el => {
        const on = el.dataset.id === shotId;
        el.classList.toggle('active', on);
        if (on) current = el;
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
    syncNav(); // leaving the picture is off while there is a pen in hand
    updateZoomable(); // the drawbar took a strip of the stage's height
    layoutCanvas();
}

// Where this shot sits in the gallery, kept so the nav state can be recomputed when
// drawing is toggled and not only when a new image arrives.
let navPos = { pos: 0, total: 0 };

// Every way OUT of the current picture, in one place: the ‹ › buttons, the filmstrip and
// (in the keydown handler) the arrow keys. All of them are off while the drawing tools are
// open — mid-annotation, a click on an arrow is never a request to abandon the drawing and
// go somewhere else. Esc or the Çiz button closes the tools and puts navigation back.
function syncNav() {
    // The GRID locks paging for the same reason drawing does: there is no one picture for
    // the arrows to move. Picking is the opposite — it is a browsing mode, and stepping
    // through the gallery is how you find what belongs in the comparison.
    const held = drawMode || cmpState === 'show';
    prevBtn.disabled = held || !(navPos.pos > 1);
    nextBtn.disabled = held || !(navPos.pos && navPos.total && navPos.pos < navPos.total);
    strip.classList.toggle('locked', drawMode);
}

// ── Compare ──────────────────────────────────────────────────────────────────
// Two states, and the second toolbar row carries one of them at a time:
//   'pick'  the filmstrip becomes a multi-select; the single picture stays on the stage
//   'show'  the stage steps aside for a grid of everything picked
// Picking stays live while showing, so a shot can be added or dropped without leaving the
// comparison. The pick order IS the grid order, which the pane headers drag around, and
// the strip's badges mirror it — a reorder is visible in both places at once.
//
// The panes hold FULL-resolution images (main sends them on demand): comparing two
// screenshots at 360px thumbnail resolution answers nothing. That is also why the pick has
// a ceiling — every one of them is decoded at once, and a decoded 2560x1600 capture is
// ~16MB of bitmap whatever its PNG weighs. Five is where the eye gives up anyway: the
// widest layout puts them in one row, and a sixth pane is a sliver nobody compares.
const MAX_COMPARE = 5;

const compareBtn = document.getElementById('compare-btn');
const cmpbar = document.getElementById('cmpbar');
const cmpHint = document.getElementById('cmp-hint');
const cmpGrid = document.getElementById('cmp-grid');
const cmpSeg = document.getElementById('cmp-layout');
const cmpAddBtn = document.getElementById('cmp-add');
const cmpStartBtn = document.getElementById('cmp-start');
const cmpExitBtn = document.getElementById('cmp-exit');

const CMP_GRIP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>'
    + '<circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>'
    + '<circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>';
const CMP_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"'
    + ' stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

let cmpState = 'off';         // 'off' | 'pick' | 'show'
let picked = [];              // shot ids, in the order the grid draws them
let cmpLayout = 'row';        // 'row' (all, sideways — the default) | 'pair' (2 per screen) | 'quad' (4)
const cmpImages = new Map();  // id -> full-size payload from main
const cmpPanes = new Map();   // id -> pane element: a reorder MOVES nodes, so no img reloads
let cmpDrag = null;           // { id, pane, pointerId } while a pane is being dragged
let cmpNotice = '';           // outranks the count in the bar until the next pick lands
// A zoom per pane: id -> explicit scale (absent or 0 = fit that pane, which the CSS does).
// A gesture on a picture zooms that picture; the toolbar control moves all of them.
const cmpZoomById = new Map();
let cmpShotPad = null;        // .cmp-shot padding — read off the element, like STAGE_PAD

function setCompareState(next) {
    if (next === cmpState) return;
    // One mode at a time: a pen in hand belongs to the single picture on the stage.
    if (next !== 'off' && drawMode) setDrawMode(false);
    cmpState = next;

    if (next === 'off') {
        picked = [];
        cmpImages.clear();
        cmpPanes.forEach(pane => pane.remove());
        cmpPanes.clear();
    } else if (!picked.length && shotId) {
        picked = [shotId]; // start from what the user is already looking at
    }

    cmpNotice = '';
    if (next !== 'show') cmpZoomById.clear(); // a comparison always opens fitted
    // Same three buttons, two scopes: one picture on the stage, every pane in the grid.
    // The tooltips have to say which, or the ± buttons look like they lost their mind the
    // first time a single pane was zoomed by hand.
    setZoomScopeTips(next === 'show');
    document.body.classList.toggle('comparing', next !== 'off');
    document.body.classList.toggle('cmp-showing', next === 'show');
    compareBtn.classList.toggle('active', next !== 'off');
    cmpbar.hidden = next === 'off';
    cmpGrid.hidden = next !== 'show';
    stage.hidden = next === 'show';
    strip.classList.toggle('picking', next !== 'off');

    syncNav();
    syncCompareBar();
    markPicked();
    if (next === 'show') renderCompare();
    // The stage was display:none, so its box is only measurable again now — and a window
    // resized meanwhile may have changed whether the picture even needs zooming.
    else { applyZoom(); updateZoomable(); }
}

function syncCompareBar() {
    if (cmpState === 'off') return;
    const n = picked.length;
    cmpStartBtn.disabled = n < 2;

    // The add button acts on the picture on the stage, so it has to say which way it will
    // go — and it is the only place that reports "this one is already in", which is the
    // thing you cannot tell by looking at the picture.
    const inCmp = !!shotId && picked.includes(shotId);
    cmpAddBtn.textContent = inCmp ? t('Karşılaştırmadan çıkar') : t('Karşılaştırmaya ekle');
    cmpAddBtn.classList.toggle('on', inCmp);
    cmpAddBtn.disabled = !shotId || (!inCmp && n >= MAX_COMPARE);

    // Without this the warning below would be wiped by whichever image read happens to
    // land next — the one thing the user needs to read is the one thing that flickers.
    cmpHint.textContent = cmpNotice ? cmpNotice : cmpState === 'show'
        ? t('{n} resim karşılaştırılıyor — sıralamak için başlığından sürükle.', { n })
        : n < 2
            ? t('Şeritten bir resme tıkla, büyük halini gör, sonra karşılaştırmaya ekle (en az 2).')
            : t('{n} resim eklendi. Yan yana koymak için Karşılaştır.', { n });
}

// The strip mirrors the grid: same numbers, same order.
function markPicked() {
    strip.querySelectorAll('.strip-item').forEach(el => {
        const at = picked.indexOf(el.dataset.id);
        el.classList.toggle('picked', at >= 0);
        const badge = el.querySelector('.pick-no');
        if (!badge) return;
        // Out: a + to press. In: where it sits in the grid.
        badge.textContent = at >= 0 ? String(at + 1) : '+';
        badge.title = badge.ariaLabel = at >= 0
            ? t('Karşılaştırmadan çıkar') : t('Karşılaştırmaya ekle');
    });
}

function togglePick(id) {
    const at = picked.indexOf(id);
    if (at >= 0) {
        picked.splice(at, 1);
        cmpImages.delete(id);
        dropPane(id);
    } else if (picked.length >= MAX_COMPARE) {
        // Say so where the count already is, rather than swallowing the click. It stays up
        // until the next pick actually lands.
        cmpNotice = t('En fazla {n} resim karşılaştırılabilir.', { n: MAX_COMPARE });
        syncCompareBar();
        return;
    } else {
        picked.push(id);
    }
    cmpNotice = '';
    markPicked();
    // One picture is not a comparison: fall back to picking rather than leaving a single
    // lonely pane in the grid.
    if (cmpState === 'show' && picked.length < 2) setCompareState('pick');
    else if (cmpState === 'show') renderCompare();
    else syncCompareBar();
}

// A pane and its zoom are dropped together, always. Three different things take a picture
// out of a comparison — the pane's own ×, its pick toggled off in the strip, the shot being
// deleted from the gallery — and a zoom left behind in the map comes back the next time
// that picture joins, against the rule that a comparison opens fitted.
function dropPane(id) {
    const pane = cmpPanes.get(id);
    if (pane) pane.remove();
    cmpPanes.delete(id);
    cmpZoomById.delete(id);
}

function buildPane(id) {
    const shot = cmpImages.get(id);
    const pane = document.createElement('div');
    pane.className = 'cmp-pane';
    pane.dataset.id = id;

    const head = document.createElement('div');
    head.className = 'cmp-head';
    head.title = t('Sürükleyerek sırasını değiştir');

    const grip = document.createElement('span');
    grip.className = 'cmp-grip';
    grip.innerHTML = CMP_GRIP;

    const no = document.createElement('span');
    no.className = 'cmp-no';

    const dim = document.createElement('span');
    dim.className = 'cmp-dim';
    dim.textContent = shot.w + ' × ' + shot.h + ' · ' + fmtTime(shot.timestamp);

    const drop = document.createElement('button');
    drop.className = 'cmp-drop';
    drop.title = t('Karşılaştırmadan çıkar');
    drop.setAttribute('aria-label', t('Karşılaştırmadan çıkar'));
    drop.innerHTML = CMP_X;
    drop.addEventListener('click', () => togglePick(id));

    head.append(grip, no, dim, drop);
    head.addEventListener('pointerdown', (e) => startPaneDrag(e, id));

    const holder = document.createElement('div');
    holder.className = 'cmp-shot';
    const im = document.createElement('img');
    im.src = shot.dataUrl;
    im.alt = t('Ekran görüntüsü');
    // Nothing can be measured before the decode, hence on load. A click on the picture
    // toggles fit ↔ 1:1 for THIS pane only — the same gesture the stage has, scoped to the
    // one picture under the cursor.
    im.addEventListener('load', () => { layoutPaneZoom(id); updateZoomLabel(); });
    im.addEventListener('click', (e) => setPaneZoom(id, paneZoom(id) ? 0 : 1, { x: e.clientX, y: e.clientY }));
    holder.appendChild(im);

    pane.append(head, holder);
    return pane;
}

// Nodes are MOVED into place (appendChild on an element already in the tree relocates it),
// which is what keeps a reorder from re-decoding every full-size image.
function layoutPanes() {
    picked.forEach((id, i) => {
        const pane = cmpPanes.get(id);
        if (!pane) return;
        pane.querySelector('.cmp-no').textContent = String(i + 1);
        cmpGrid.appendChild(pane);
    });
}

async function renderCompare() {
    const missing = picked.filter(id => !cmpImages.has(id));
    if (missing.length) {
        const got = await window.api.viewerCompareImages(missing);
        (got || []).forEach(s => cmpImages.set(s.id, s));
        if (cmpState !== 'show') return;      // the user left while the read was in flight
        // Only what THIS read asked for and did not get back is gone from the gallery.
        // Filtering the pick against the whole image map instead would throw away every id
        // added WHILE the read was in flight — each of those has its own render on the way,
        // and a handful of quick clicks on the strip used to wipe the selection that way.
        const gone = new Set(missing.filter(id => !cmpImages.has(id)));
        if (gone.size) {
            picked = picked.filter(id => !gone.has(id));
            if (picked.length < 2) { setCompareState('pick'); return; }
        }
    }
    // An id whose image has not landed yet is skipped, not faked: the render that fetched
    // it builds its pane.
    for (const id of picked) {
        if (!cmpPanes.has(id) && cmpImages.has(id)) cmpPanes.set(id, buildPane(id));
    }
    for (const id of [...cmpPanes.keys()]) {
        if (!picked.includes(id)) dropPane(id);
    }
    // Bound the map: a shot dropped mid-read can otherwise leave its megabytes behind.
    for (const id of [...cmpImages.keys()]) if (!picked.includes(id)) cmpImages.delete(id);
    layoutPanes();
    applyCompareLayout();
    syncCompareBar();
    markPicked();
}

// The pane height is computed rather than written as a percentage: a percentage row in a
// PADDED scroll container measures against the content box and the padding is then added
// on top, which would leave a permanent scrollbar around a grid that fits exactly. The
// numbers are read off the element, same as STAGE_PAD.
function applyCompareLayout() {
    cmpGrid.classList.remove('pair', 'quad', 'row');
    cmpGrid.classList.add(cmpLayout);
    cmpSeg.querySelectorAll('.cmp-mode').forEach(b => b.classList.toggle('active', b.dataset.layout === cmpLayout));

    const cs = getComputedStyle(cmpGrid);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const gap = parseFloat(cs.rowGap) || 0;
    const rows = cmpLayout === 'quad' ? 2 : 1;
    const room = cmpGrid.clientHeight - pad; // clientHeight counts the padding
    // A floor, so a very short window still shows a usable pane instead of a sliver.
    const h = Math.max(140, Math.floor((room - gap * (rows - 1)) / rows));
    cmpGrid.style.setProperty('--cmp-pane-h', h + 'px');

    // The panes just changed size: fit means something else now, and so does the cursor.
    applyCompareZoom();
}

// ── Zooming the grid ─────────────────────────────────────────────────────────

// The room a pane leaves the picture. clientHeight counts the padding, so every "how much
// fits" question has to take it back off — the same correction stageRoom() makes. Read
// lazily because .cmp-shot does not exist until the first pane is built.
function paneRoom(holder) {
    if (cmpShotPad === null) cmpShotPad = parseFloat(getComputedStyle(holder).paddingTop) || 0;
    return { w: holder.clientWidth - cmpShotPad * 2, h: holder.clientHeight - cmpShotPad * 2 };
}

// Every pane holds ITS OWN zoom — 0 (or nothing) means "fit this pane", any other value is
// an explicit scale. They are separate pictures, and looking closely at one of them is the
// most ordinary thing to want in a comparison, so a gesture on a picture stays on that
// picture. Moving all of them at once is still one action, but a deliberate one: the
// toolbar control and the ± keys (setCompareZoom).
const paneZoom = (id) => cmpZoomById.get(id) || 0;

// What "sığdır" means for one picture in one pane.
function paneFit(pane) {
    const im = pane.querySelector('img');
    if (!im || !im.naturalWidth) return 1;
    const room = paneRoom(pane.querySelector('.cmp-shot'));
    return Math.min(1, room.w / im.naturalWidth, room.h / im.naturalHeight);
}

// What a pane is showing right now, fit included — the scale a ± step starts from.
function paneScale(id) {
    const pane = cmpPanes.get(id);
    return paneZoom(id) || (pane ? paneFit(pane) : 1);
}

// The grid's zoom when there IS one: the value every pane shares (0 = all fitted), or null
// while they hold different scales — which is now an ordinary state, not a glitch.
function gridZoom() {
    const ids = [...cmpPanes.keys()];
    if (!ids.length) return 0;
    const first = paneZoom(ids[0]);
    return ids.every(id => paneZoom(id) === first) ? first : null;
}

// Lay one pane out at its own zoom, holding still the thing its viewer is looking at: the
// point under the cursor when the cursor is over THIS pane, the middle of what it is
// showing otherwise. Without that second half, a pane moved by the toolbar (which moves
// every pane, cursor or no cursor) walks off to its own top-left corner.
function layoutPaneZoom(id, anchor) {
    const pane = cmpPanes.get(id);
    if (!pane) return;
    const holder = pane.querySelector('.cmp-shot');
    const im = holder.querySelector('img');
    if (!im.naturalWidth) return;
    const z = paneZoom(id);

    const hr = holder.getBoundingClientRect();
    const before = im.getBoundingClientRect();
    const over = anchor && anchor.x >= hr.left && anchor.x <= hr.right
        && anchor.y >= hr.top && anchor.y <= hr.bottom;
    const ax = over ? anchor.x : hr.left + holder.clientWidth / 2;
    const ay = over ? anchor.y : hr.top + holder.clientHeight / 2;
    // Clamped to the picture: in fit mode the pane's middle can sit in the letterbox, and
    // an anchor outside the image would aim the scroll past its edge.
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const fx = clamp01(before.width ? (ax - before.left) / before.width : 0.5);
    const fy = clamp01(before.height ? (ay - before.top) / before.height : 0.5);

    if (z) {
        holder.classList.add('zoomed');
        im.style.width = Math.round(im.naturalWidth * z) + 'px';
    } else {
        holder.classList.remove('zoomed');
        im.style.width = '';
    }

    const fit = paneFit(pane);
    // Below 1:1 a click makes the picture bigger, above it smaller — the cursor says which.
    holder.classList.toggle('zoomable', (z || fit) < 0.995);
    holder.classList.toggle('shrunk', !!z && z < fit);

    if (z) {
        const after = im.getBoundingClientRect();
        holder.scrollLeft += (after.left + fx * after.width) - ax;
        holder.scrollTop += (after.top + fy * after.height) - ay;
    }
}

// One pane, one zoom. No snapping onto fit the way setZoom() does: 0 is how fit is asked
// for — a second click on the picture, the readout button, Cmd+0.
function setPaneZoom(id, next, anchor) {
    if (!cmpPanes.has(id)) return;
    const target = next === 0 ? 0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (target === paneZoom(id)) return;
    cmpZoomById.set(id, target);
    layoutPaneZoom(id, anchor);
    updateZoomLabel();
}

// Re-lay every pane out at whatever zoom it already has: the panes changed SIZE (a layout
// switch, a resized window, the maximize inset), not their scales.
function applyCompareZoom(anchor) {
    for (const id of cmpPanes.keys()) layoutPaneZoom(id, anchor);
    updateZoomLabel();
}

// The toolbar's zoom control and the ± keys are the "all of them" half: one scale across
// the grid, which is what makes two pictures comparable at a glance. Panes already sitting
// on the target are left alone, so a no-op cannot scroll them.
function setCompareZoom(next, anchor) {
    const target = next === 0 ? 0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    let changed = false;
    for (const id of cmpPanes.keys()) {
        if (paneZoom(id) === target) continue;
        cmpZoomById.set(id, target);
        layoutPaneZoom(id, anchor);
        changed = true;
    }
    if (changed) updateZoomLabel();
}

// ── Reordering the grid ──────────────────────────────────────────────────────
// Pointer events rather than HTML5 drag-and-drop: the panes hold multi-megabyte data URLs,
// and a native drag would ask the platform to build a drag image out of one of them. The
// dragged pane keeps the pointer (setPointerCapture), and the pane under the cursor is
// found by hit-testing, so the two never fight over the events.
function startPaneDrag(e, id) {
    if (e.button !== 0 || e.target.closest('.cmp-drop')) return;
    const pane = cmpPanes.get(id);
    if (!pane || picked.length < 2) return;
    e.preventDefault(); // no text selection dragging along with it
    cmpDrag = { id, pane, pointerId: e.pointerId };
    pane.classList.add('dragging');
    pane.setPointerCapture(e.pointerId);
}

document.addEventListener('pointermove', (e) => {
    if (!cmpDrag) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && under.closest('.cmp-pane');
    if (!target || target === cmpDrag.pane) return;
    const from = picked.indexOf(cmpDrag.id);
    const to = picked.indexOf(target.dataset.id);
    if (from < 0 || to < 0 || from === to) return;
    // Move-to-index, not swap: dragging one pane across three lands it after all three,
    // which is what a sorted row of images is expected to do.
    picked.splice(from, 1);
    picked.splice(to, 0, cmpDrag.id);
    layoutPanes();
    markPicked();
});

function endPaneDrag() {
    if (!cmpDrag) return;
    cmpDrag.pane.classList.remove('dragging');
    try { cmpDrag.pane.releasePointerCapture(cmpDrag.pointerId); } catch (err) { /* already gone */ }
    cmpDrag = null;
}

document.addEventListener('pointerup', endPaneDrag);
document.addEventListener('pointercancel', endPaneDrag);

// Ctrl/Cmd+wheel — and the trackpad pinch, which arrives as exactly that — zooms the pane
// under the cursor and only that one. A plain wheel is left alone: it scrolls the pane
// while the pane has somewhere to go, and the grid once it does not, both natively.
cmpGrid.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const pane = e.target.closest('.cmp-pane');
    if (!pane) return; // the grid's own padding — nothing under the cursor to zoom
    const id = pane.dataset.id;
    setPaneZoom(id, paneScale(id) * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
}, { passive: false });

compareBtn.addEventListener('click', () => setCompareState(cmpState === 'off' ? 'pick' : 'off'));
cmpAddBtn.addEventListener('click', () => { if (shotId) togglePick(shotId); });
cmpStartBtn.addEventListener('click', () => { if (picked.length >= 2) setCompareState('show'); });
cmpExitBtn.addEventListener('click', () => setCompareState('off'));

cmpSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.cmp-mode');
    if (!btn || btn.dataset.layout === cmpLayout) return;
    cmpLayout = btn.dataset.layout;
    applyCompareLayout();
    // The grid scrolls in a different axis per layout; start from the top of the new one.
    cmpGrid.scrollTo({ top: 0, left: 0 });
});

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

    // The marks have just been BAKED into a new gallery entry, so they stop being a
    // pending edit on this one. Leaving them here meant the same drawing existed twice —
    // flattened into the copy, and still floating on the original — and the second one
    // came back the moment the viewer landed on the original again. That is what made
    // deleting look like it had removed the wrong picture: you deleted the copy, the
    // viewer moved to the neighbour (the original), and your drawing reappeared on it.
    shapesById.delete(shotId);
    shapes = [];
    repaint();

    // The edit is done and filed: main will swap the viewer to the new copy, so drop the
    // tools (and the selection with them) rather than hanging them over a fresh image.
    setDrawMode(false);
}

// ── Main-process traffic ─────────────────────────────────────────────────────

window.api.onViewerList((list) => {
    // Forget the drawings of shots that no longer exist, so the map cannot outlive the
    // gallery and resurrect marks onto something that replaced them.
    const live = new Set((list || []).map(s => s.id));
    for (const id of [...shapesById.keys()]) if (!live.has(id)) shapesById.delete(id);

    // A shot that no longer exists cannot stay in the comparison either — deleting one
    // from inside the viewer is the ordinary way this happens.
    if (cmpState !== 'off' && picked.some(id => !live.has(id))) {
        picked = picked.filter(id => live.has(id));
        for (const id of [...cmpImages.keys()]) if (!live.has(id)) cmpImages.delete(id);
        for (const id of [...cmpPanes.keys()]) if (!live.has(id)) dropPane(id);
        if (cmpState === 'show' && picked.length < 2) setCompareState('pick');
        else if (cmpState === 'show') renderCompare();
        else syncCompareBar();
    }

    const key = (list || []).map(s => s.id).join(',');
    if (key === stripKey) { markActiveThumb(); markPicked(); return; } // same set — keep DOM, avoid flicker
    stripKey = key;
    strip.innerHTML = '';
    (list || []).forEach(s => {
        // Wrapped: the pick badge needs somewhere to sit, and an <img> has no room for one
        // (no pseudo-elements on replaced content).
        const item = document.createElement('div');
        item.className = 'strip-item';
        item.dataset.id = s.id;
        const thumb = document.createElement('img');
        thumb.src = s.thumb;
        thumb.alt = t('küçük resim');
        const badge = document.createElement('button');
        badge.className = 'pick-no';
        item.append(thumb, badge);
        // A click SHOWS the shot — that is what the strip has always done, and picking needs
        // it most: a 68px thumbnail is not something you can choose from. Putting a shot IN
        // the comparison is its own click, on the badge (or on the bar's button, for the one
        // already on screen). Once the grid is up there is no stage left to show anything
        // on, so there the click toggles instead.
        item.addEventListener('click', () => {
            if (cmpState === 'show') togglePick(s.id);
            else window.api.viewerSelect(s.id);
        });
        badge.addEventListener('click', (e) => {
            e.stopPropagation(); // the badge picks; the thumbnail underneath navigates
            togglePick(s.id);
        });
        strip.appendChild(item);
    });
    markActiveThumb();
    markPicked();
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

    navPos = { pos: data.pos, total: data.total };
    syncNav();
    markActiveThumb();
    // A different picture means a different answer to "is this one in the comparison?".
    syncCompareBar();
});

// While the window is maximized its frame overhangs the work area, so the content comes in
// by whatever main measured (see sendWindowState in screenshot-handlers.js) — and the
// maximize button turns into a restore button.
window.api.onViewerWindowState((s) => {
    const inset = (s && s.inset) || {};
    const root = document.documentElement.style;
    for (const side of ['top', 'right', 'bottom', 'left']) {
        root.setProperty('--inset-' + side, Math.max(0, inset[side] || 0) + 'px');
    }
    const maximized = !!(s && s.maximized);
    document.body.classList.toggle('maximized', maximized);
    const label = maximized ? t('Önceki boyut') : t('Tam ekran');
    maxBtn.title = label;
    maxBtn.setAttribute('aria-label', label);
    // Everything on screen just changed size.
    if (cmpState === 'show') { applyCompareLayout(); return; }
    applyZoom();
    updateZoomable();
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

window.addEventListener('resize', () => {
    // The grid is the only thing on screen while comparing, and its pane height is in px,
    // so it is ours to redo. The stage is display:none — measuring it would only produce
    // zeroes for fit mode and the canvas box.
    if (cmpState === 'show') { applyCompareLayout(); return; }
    // Resizing moves fit onto the current scale often enough that leaving a manual
    // zoom there would mean scrollbars around a picture that already fits. Only the
    // coincidence collapses — a deliberate zoom-out below fit is left alone.
    if (zoom && Math.abs(zoom - fitScale()) < fitScale() * 0.01) {
        zoom = 0;
        applyZoom();
    }
    updateZoomable();
    layoutCanvas();
    updateZoomLabel(); // the fit percentage moves with the window
});
// Safety net for anything the explicit calls miss. Kept in a variable on purpose:
// an observer nobody holds a reference to gets garbage-collected and silently stops.
const imgObserver = new ResizeObserver(layoutCanvas);
imgObserver.observe(img);

// Click toggles fit ↔ actual size, anchored where you clicked. Not while drawing —
// the canvas owns the pointer then.
img.addEventListener('click', (e) => toggleActualSize({ x: e.clientX, y: e.clientY }));
zoomBtn.addEventListener('click', zoomButtonClick);
zoomOutBtn.addEventListener('click', () => zoomTo(scaleNow() / ZOOM_STEP));
zoomInBtn.addEventListener('click', () => zoomTo(scaleNow() * ZOOM_STEP));

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
minBtn.addEventListener('click', () => window.api.viewerMinimize());
maxBtn.addEventListener('click', () => window.api.viewerToggleMaximize());
document.getElementById('close-btn').addEventListener('click', () => window.api.viewerClose());

document.addEventListener('keydown', (e) => {
    if (e.target === textInput || e.target === customInput) return; // the text box owns its keys
    const mod = e.metaKey || e.ctrlKey;
    // Esc unwinds one step at a time — closing the window would take the drawing, or the
    // comparison just assembled, with it.
    if (e.key === 'Escape') {
        if (crop) setCrop(null);
        else if (drawMode) setDrawMode(false);
        else if (cmpState === 'show') setCompareState('pick'); // back to the picker, not out
        else if (cmpState === 'pick') setCompareState('off');
        else window.api.viewerClose();
        return;
    }
    // Zoom is the one thing that works in both modes — on the stage's picture, or on every
    // pane of the grid (zoomTo picks which). '=' is what Cmd++ reports unshifted.
    if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomTo(scaleNow() * ZOOM_STEP); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomTo(scaleNow() / ZOOM_STEP); return; }
    if (mod && e.key === '0') { e.preventDefault(); zoomTo(0); return; }
    if (mod && e.key === '1') { e.preventDefault(); zoomTo(1); return; }
    // Paging works wherever there is one picture on the stage — including a pick, which is
    // exactly when you want to walk the gallery. Not while drawing (see syncNav) and not
    // over the grid, which has no current shot to move.
    if (!drawMode && cmpState !== 'show' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        window.api.viewerNav(e.key === 'ArrowLeft' ? 'prev' : 'next');
        return;
    }
    // Everything below acts on THE current shot — undo, copy — and none of that means
    // anything while a grid of four is on screen.
    if (cmpState !== 'off') return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copyCurrent(); }
});

// ── Narrow toolbar: "…" overflow menu ──────────────────────────────────────────
// Measured, not media-queried: what fits depends on the translated labels. The row is
// measured in its expanded state each time, so there is no oscillation between states.
(function () {
    const toolbar = document.querySelector('.toolbar');
    const actions = document.querySelector('.toolbar-actions');
    const moreBtn = document.getElementById('more-btn');
    const tools = document.getElementById('tb-tools');
    if (!toolbar || !actions || !moreBtn || !tools) return;

    const TITLE_MIN = 90;   // the title keeps at least a dimension chip
    const PADDING = 24;     // .toolbar horizontal padding

    function closeMenu() {
        document.body.classList.remove('tb-menu-open');
        moreBtn.setAttribute('aria-expanded', 'false');
    }

    function layoutToolbar() {
        const wasOpen = document.body.classList.contains('tb-menu-open');
        document.body.classList.remove('tb-collapsed', 'tb-menu-open');
        const need = actions.scrollWidth + TITLE_MIN + PADDING;
        if (need > toolbar.clientWidth) {
            document.body.classList.add('tb-collapsed');
            if (wasOpen) document.body.classList.add('tb-menu-open');
        } else {
            moreBtn.setAttribute('aria-expanded', 'false');
        }
    }

    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = document.body.classList.toggle('tb-menu-open');
        moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Picking a tool closes the menu; the tool's own handler already ran (bubbling).
    tools.addEventListener('click', () => {
        if (document.body.classList.contains('tb-collapsed')) closeMenu();
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#tb-tools, #more-btn')) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('tb-menu-open')) {
            e.stopPropagation();
            closeMenu();
        }
    }, true);

    window.addEventListener('resize', layoutToolbar);
    // After the first paint (fonts and translated labels in place).
    requestAnimationFrame(() => requestAnimationFrame(layoutToolbar));
})();
