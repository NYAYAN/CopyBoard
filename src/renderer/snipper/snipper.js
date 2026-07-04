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

// Blur perf: throttle the heavy recompute and reuse scratch canvases
let lastBlurTime = 0;
let lastBlurX = 0, lastBlurY = 0; // last pointer pos so mouseup can commit the release rect
let blurTempCanvas = null;
let blurOutCanvas = null;

function saveState() {
    state.history.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
    // Each entry is a full-canvas ImageData (~33MB at 4K); cap to bound peak memory
    if (state.history.length > 10) state.history.shift();
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

// Ensure sharp pixel rendering
ctx.imageSmoothingEnabled = false;
drawCtx.imageSmoothingEnabled = false;

// --- Capture & Initialize Screen ---
window.api.onCaptureScreen((dataUrl, mode, sourceId, quality, captureWidth, captureHeight) => {
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

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    initDrawCtx(); // Ensure context properties are set after canvas.width/height resets them
    clearOverlay();
    resetUI();

    // Use the high-res PNG screenshot from main process (desktopCapturer thumbnail)
    if (dataUrl && dataUrl.length > 100) {
        const img = new Image();
        img.onload = () => {
            // Draw at native resolution — pixel-perfect like Snipping Tool
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            drawOverlay(0, 0, logicalW, logicalH);
            document.body.classList.add('ready');
            window.api.notifyReady();
        };
        img.src = dataUrl;
    } else {
        // Thumbnail failed and no stream available. This shouldn't happen with our new capture-service.
        drawOverlay(0, 0, logicalW, logicalH);
        document.body.classList.add('ready');
        setTimeout(() => window.api.notifyReady(), 50);
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
    if (!blurTempCanvas) blurTempCanvas = document.createElement('canvas');
    const tempCanvas = blurTempCanvas;
    tempCanvas.width = cw;
    tempCanvas.height = ch;
    const tempCtx = tempCanvas.getContext('2d');

    tempCtx.drawImage(canvas, x * sx, y * sy, w * sx, h * sy, 0, 0, cw, ch);
    tempCtx.drawImage(drawCanvas, x * sx, y * sy, w * sx, h * sy, 0, 0, cw, ch);

    const imageData = tempCtx.getImageData(0, 0, cw, ch);
    const scale = (sx + sy) / 2;
    const pixelSize = Math.max(2, Math.floor(10 * scale));

    const bw = cw;
    const bh = ch;

    // Apply pixelation effect
    for (let py = 0; py < bh; py += pixelSize) {
        for (let px = 0; px < bw; px += pixelSize) {
            let r = 0, g = 0, b = 0, a = 0, count = 0;

            // Calculate average color in block
            for (let dy = 0; dy < pixelSize && py + dy < bh; dy++) {
                for (let dx = 0; dx < pixelSize && px + dx < bw; dx++) {
                    const i = ((py + dy) * bw + (px + dx)) * 4;
                    r += imageData.data[i];
                    g += imageData.data[i + 1];
                    b += imageData.data[i + 2];
                    a += imageData.data[i + 3];
                    count++;
                }
            }

            r = Math.floor(r / count);
            g = Math.floor(g / count);
            b = Math.floor(b / count);
            a = Math.floor(a / count);

            // Fill block with average color
            for (let dy = 0; dy < pixelSize && py + dy < bh; dy++) {
                for (let dx = 0; dx < pixelSize && px + dx < bw; dx++) {
                    const i = ((py + dy) * bw + (px + dx)) * 4;
                    imageData.data[i] = r;
                    imageData.data[i + 1] = g;
                    imageData.data[i + 2] = b;
                    imageData.data[i + 3] = a;
                }
            }
        }
    }

    drawCtx.save();
    drawCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (!blurOutCanvas) blurOutCanvas = document.createElement('canvas');
    const tempImg = blurOutCanvas;
    tempImg.width = bw; tempImg.height = bh;
    tempImg.getContext('2d').putImageData(imageData, 0, 0);
    drawCtx.drawImage(tempImg, x * sx, y * sy);
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

function getFinalImage() {
    if (!state.selectionRect) return null;
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
        alert('Image generation failed: ' + e.message);
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

