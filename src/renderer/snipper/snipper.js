const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const drawCanvas = document.getElementById('draw-canvas');
const drawCtx = drawCanvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const toolbar = document.getElementById('toolbar');
const overlay = document.getElementById('overlay');
const textInputContainer = document.getElementById('text-input-container');
const textInput = document.getElementById('text-input');
const textDragHandle = document.getElementById('text-drag-handle');

const state = {
    isSelecting: false, isDrawing: false, isMoving: false, isResizing: false, isDraggingText: false,
    activeHandle: null, resizeStartRect: null, selectionRect: null, activeTool: null,
    startX: 0, startY: 0, dragOffX: 0, dragOffY: 0, savedImageData: null,
    history: [],
    dpr: window.devicePixelRatio || 1
};

function saveState() {
    state.history.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
    if (state.history.length > 20) state.history.shift();
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

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    drawCanvas.width = w * dpr;
    drawCanvas.height = h * dpr;
    drawCanvas.style.width = w + 'px';
    drawCanvas.style.height = h + 'px';

    drawCtx.setTransform(1, 0, 0, 1, 0, 0);
    drawCtx.scale(dpr, dpr);
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.strokeStyle = drawCtx.fillStyle = '#ff0000';
    drawCtx.lineWidth = 3;
    drawCtx.font = "20px Arial";
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Preload Verification ---
if (!window.api) {
    alert('CRITICAL: window.api is UNDEFINED! Preload script failed to load.');
} else {
    console.log('window.api is available:', Object.keys(window.api));
}

// --- Capture & Initialize Screen ---
window.api.onCaptureScreen((dataUrl) => {
    const dpr = state.dpr;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawCtx.clearRect(0, 0, drawCanvas.width / dpr, drawCanvas.height / dpr);
    resetUI();
    const img = new Image();
    img.onload = () => {
        // Draw to fill the scaled canvas
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setTimeout(() => window.api.notifyReady(), 50);
    };
    img.src = dataUrl;
});

function resetUI() {
    Object.assign(state, {
        isSelecting: false, isDrawing: false, isMoving: false, isResizing: false,
        isDraggingText: false, selectionRect: null, activeTool: null, history: []
    });
    const dpr = state.dpr;
    drawCtx.clearRect(0, 0, drawCanvas.width / dpr, drawCanvas.height / dpr);
    selectionBox.style.display = toolbar.style.display = textInputContainer.style.display = 'none';
    selectionBox.classList.add('hidden');
    overlay.style.display = 'block';
    document.body.classList.remove('drawing', 'selecting');
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
}

const dimensionsLabel = document.getElementById('dimensions-label');

function updateDimensions(w, h) {
    if (dimensionsLabel) {
        dimensionsLabel.textContent = `${Math.round(w)} x ${Math.round(h)}`;
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
            if (state.activeTool === 'pen') { drawCtx.beginPath(); drawCtx.moveTo(state.startX, state.startY); }
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
        overlay.style.display = 'none';
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
    } else if (state.isMoving) {
        selectionBox.style.left = Math.max(0, Math.min(e.clientX - state.dragOffX, window.innerWidth - selectionBox.offsetWidth)) + 'px';
        selectionBox.style.top = Math.max(0, Math.min(e.clientY - state.dragOffY, window.innerHeight - selectionBox.offsetHeight)) + 'px';
    } else if (state.isSelecting) {
        const w = Math.abs(e.clientX - state.startX);
        const h = Math.abs(e.clientY - state.startY);
        selectionBox.style.width = w + 'px';
        selectionBox.style.height = h + 'px';
        selectionBox.style.left = Math.min(e.clientX, state.startX) + 'px';
        selectionBox.style.top = Math.min(e.clientY, state.startY) + 'px';
        updateDimensions(w, h);
    } else if (state.isDrawing) {
        drawCtx.save();
        const cp = new Path2D(); cp.rect(state.selectionRect.x, state.selectionRect.y, state.selectionRect.w, state.selectionRect.h);
        drawCtx.clip(cp);
        if (state.activeTool === 'pen') {
            drawCtx.beginPath(); drawCtx.moveTo(state.startX, state.startY);
            drawCtx.lineTo(e.clientX, e.clientY); drawCtx.stroke();
            state.startX = e.clientX; state.startY = e.clientY;
        } else if (state.activeTool === 'blur') {
            drawCtx.putImageData(state.savedImageData, 0, 0);
            let w = e.clientX - state.startX, h = e.clientY - state.startY;
            if (Math.abs(w) > 5 && Math.abs(h) > 5) {
                const x = Math.min(state.startX, e.clientX);
                const y = Math.min(state.startY, e.clientY);
                applyBlur(x, y, Math.abs(w), Math.abs(h));
            }
        } else {
            drawCtx.putImageData(state.savedImageData, 0, 0);
            let w = e.clientX - state.startX, h = e.clientY - state.startY;
            if (e.shiftKey && (state.activeTool === 'rect' || state.activeTool === 'circle')) {
                const s = Math.max(Math.abs(w), Math.abs(h));
                w = w < 0 ? -s : s; h = h < 0 ? -s : s;
            }
            if (state.activeTool === 'rect') drawCtx.strokeRect(state.startX, state.startY, w, h);
            else if (state.activeTool === 'circle') {
                drawCtx.beginPath(); drawCtx.ellipse(state.startX + w / 2, state.startY + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, 2 * Math.PI);
                drawCtx.stroke();
            } else if (state.activeTool === 'arrow') drawArrow(drawCtx, state.startX, state.startY, e.clientX, e.clientY);
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

function drawArrow(c, fx, fy, tx, ty) {
    const hl = 10, a = Math.atan2(ty - fy, tx - fx);
    c.beginPath(); c.moveTo(fx, fy); c.lineTo(tx, ty);
    c.lineTo(tx - hl * Math.cos(a - Math.PI / 6), ty - hl * Math.sin(a - Math.PI / 6));
    c.moveTo(tx, ty); c.lineTo(tx - hl * Math.cos(a + Math.PI / 6), ty - hl * Math.sin(a + Math.PI / 6));
    c.stroke();
}

function applyBlur(x, y, w, h) {
    const dpr = state.dpr;
    // Create a temporary canvas to merge both layers at physical resolution
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w * dpr;
    tempCanvas.height = h * dpr;
    const tempCtx = tempCanvas.getContext('2d');

    // Draw screen canvas first
    tempCtx.drawImage(canvas, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, w * dpr, h * dpr);
    // Draw drawing canvas on top
    tempCtx.drawImage(drawCanvas, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, w * dpr, h * dpr);

    // Get merged image data
    const imageData = tempCtx.getImageData(0, 0, w * dpr, h * dpr);
    const pixelSize = Math.max(2, Math.floor(10 * dpr)); // Blur intensity adjusted for DPI

    const bw = w * dpr;
    const bh = h * dpr;

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

    // Draw blurred result to drawing canvas
    // We need to disable the scale temporarily or account for it
    drawCtx.save();
    drawCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset to physical pixels
    const tempImg = document.createElement('canvas'); // Reuse or create
    tempImg.width = bw; tempImg.height = bh;
    tempImg.getContext('2d').putImageData(imageData, 0, 0);
    drawCtx.drawImage(tempImg, x * dpr, y * dpr);
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
    const dpr = state.dpr;
    const r = state.selectionRect;
    const tc = document.createElement('canvas');
    tc.width = r.w * dpr;
    tc.height = r.h * dpr;
    const tctx = tc.getContext('2d');

    tctx.drawImage(canvas, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr, 0, 0, r.w * dpr, r.h * dpr);
    tctx.drawImage(drawCanvas, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr, 0, 0, r.w * dpr, r.h * dpr);

    // PNG for lossless quality, or JPEG 1.0
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
        e.preventDefault(); const v = textInput.value.trim();
        if (v) {
            saveState();
            drawCtx.save();
            const cp = new Path2D(); cp.rect(state.selectionRect.x, state.selectionRect.y, state.selectionRect.w, state.selectionRect.h);
            drawCtx.clip(cp);
            const ir = textInput.getBoundingClientRect(); let x = ir.left + 10, y = ir.top + 22;
            v.split('\n').forEach(l => { drawCtx.fillText(l, x, y); y += 24; });
            drawCtx.restore();
        }
        textInputContainer.style.display = 'none'; textInput.value = '';
    } else if (e.key === 'Escape') { textInputContainer.style.display = 'none'; textInput.value = ''; }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.api.closeSnipper();
    if (e.ctrlKey && e.key.toLowerCase() === 'z') undo();
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        e.preventDefault(); // Prevent default copy which might fail if nothing focusable
        buttons['btn-copy']();
    }
});

document.querySelectorAll('.color-dot').forEach(d => d.addEventListener('click', () => {
    document.querySelectorAll('.color-dot').forEach(dot => dot.classList.remove('active'));
    d.classList.add('active');
    drawCtx.strokeStyle = drawCtx.fillStyle = d.dataset.color;
}));

// Color palette toggle
const colorToggle = document.getElementById('color-toggle');
const colorGroup = document.querySelector('.color-group');
colorToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    colorGroup.classList.toggle('collapsed');
    colorGroup.classList.toggle('expanded');
    colorToggle.classList.toggle('active');
});

