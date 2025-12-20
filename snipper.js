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
    history: []
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
    canvas.width = drawCanvas.width = window.innerWidth;
    canvas.height = drawCanvas.height = window.innerHeight;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.strokeStyle = drawCtx.fillStyle = '#ff0000';
    drawCtx.lineWidth = 3;
    drawCtx.font = "20px Arial";
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

window.api.onCaptureScreen((dataUrl) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    resetUI();
    const img = new Image();
    img.onload = () => {
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
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    selectionBox.style.display = toolbar.style.display = textInputContainer.style.display = 'none';
    selectionBox.classList.add('hidden');
    overlay.style.display = 'block';
    document.body.classList.remove('drawing');
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
}

window.addEventListener('mousedown', (e) => {
    if (e.target.closest('.toolbar')) return;
    if (e.target === textDragHandle) {
        state.isDraggingText = true;
        const r = textInputContainer.getBoundingClientRect();
        state.dragOffX = e.clientX - r.left; state.dragOffY = e.clientY - r.top;
        return;
    }
    if (state.selectionRect) {
        if (e.target.classList.contains('resize-handle')) {
            state.isResizing = true; state.activeHandle = e.target.dataset.handle;
            const b = selectionBox.getBoundingClientRect();
            state.resizeStartRect = { left: b.left, top: b.top, width: b.width, height: b.height };
            state.startX = e.clientX; state.startY = e.clientY;
            toolbar.style.display = 'none';
            return;
        }
        if (state.activeTool) {
            const r = state.selectionRect;
            if (e.clientX < r.x || e.clientX > r.x + r.w || e.clientY < r.y || e.clientY > r.y + r.h) return;

            if (state.activeTool === 'text') {
                textInputContainer.style.left = e.clientX + 'px'; textInputContainer.style.top = (e.clientY - 20) + 'px';
                textInputContainer.style.display = 'flex'; textInputContainer.classList.remove('hidden');
                setTimeout(() => textInput.focus(), 0);
                return;
            }

            saveState(); // Save state before drawing
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
        overlay.style.display = 'none';
        state.startX = e.clientX; state.startY = e.clientY;
        selectionBox.style.width = selectionBox.style.height = '0px';
        selectionBox.style.left = state.startX + 'px'; selectionBox.style.top = state.startY + 'px';
        selectionBox.style.display = 'block'; selectionBox.classList.remove('hidden');
    }
});

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
    } else if (state.isMoving) {
        selectionBox.style.left = Math.max(0, Math.min(e.clientX - state.dragOffX, window.innerWidth - selectionBox.offsetWidth)) + 'px';
        selectionBox.style.top = Math.max(0, Math.min(e.clientY - state.dragOffY, window.innerHeight - selectionBox.offsetHeight)) + 'px';
    } else if (state.isSelecting) {
        selectionBox.style.width = Math.abs(e.clientX - state.startX) + 'px';
        selectionBox.style.height = Math.abs(e.clientY - state.startY) + 'px';
        selectionBox.style.left = Math.min(e.clientX, state.startX) + 'px';
        selectionBox.style.top = Math.min(e.clientY, state.startY) + 'px';
    } else if (state.isDrawing) {
        drawCtx.save();
        const cp = new Path2D(); cp.rect(state.selectionRect.x, state.selectionRect.y, state.selectionRect.w, state.selectionRect.h);
        drawCtx.clip(cp);
        if (state.activeTool === 'pen') {
            drawCtx.beginPath(); drawCtx.moveTo(state.startX, state.startY);
            drawCtx.lineTo(e.clientX, e.clientY); drawCtx.stroke();
            state.startX = e.clientX; state.startY = e.clientY;
        } else {
            drawCtx.putImageData(state.savedImageData, 0, 0);
            const w = e.clientX - state.startX, h = e.clientY - state.startY;
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
});

function showToolbar(r) {
    toolbar.style.display = 'flex';
    let t = r.bottom + 10, l = Math.max(r.left, r.right - toolbar.offsetWidth);
    if (t + toolbar.offsetHeight > window.innerHeight) t = r.top - toolbar.offsetHeight - 10;
    toolbar.style.top = t + 'px'; toolbar.style.left = l + 'px';
}

function drawArrow(c, fx, fy, tx, ty) {
    const hl = 10, a = Math.atan2(ty - fy, tx - fx);
    c.beginPath(); c.moveTo(fx, fy); c.lineTo(tx, ty);
    c.lineTo(tx - hl * Math.cos(a - Math.PI / 6), ty - hl * Math.sin(a - Math.PI / 6));
    c.moveTo(tx, ty); c.lineTo(tx - hl * Math.cos(a + Math.PI / 6), ty - hl * Math.sin(a + Math.PI / 6));
    c.stroke();
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
    const tc = document.createElement('canvas'); tc.width = state.selectionRect.w; tc.height = state.selectionRect.h;
    const tctx = tc.getContext('2d');
    tctx.drawImage(canvas, state.selectionRect.x, state.selectionRect.y, state.selectionRect.w, state.selectionRect.h, 0, 0, state.selectionRect.w, state.selectionRect.h);
    tctx.drawImage(drawCanvas, state.selectionRect.x, state.selectionRect.y, state.selectionRect.w, state.selectionRect.h, 0, 0, state.selectionRect.w, state.selectionRect.h);
    return tc.toDataURL('image/png');
}

document.getElementById('btn-close').addEventListener('click', () => window.api.closeSnipper());
document.getElementById('btn-copy').addEventListener('click', () => { const d = getFinalImage(); if (d) window.api.sendCopyImage(d); });
document.getElementById('btn-save').addEventListener('click', () => { const d = getFinalImage(); if (d) window.api.sendSaveImage(d); });
document.getElementById('btn-undo').addEventListener('click', undo);

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); const v = textInput.value.trim();
        if (v) {
            saveState(); // Save state before adding text
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
});

document.querySelectorAll('.color-dot').forEach(d => d.addEventListener('click', () => {
    document.querySelectorAll('.color-dot').forEach(dot => dot.classList.remove('active'));
    d.classList.add('active');
    drawCtx.strokeStyle = drawCtx.fillStyle = d.dataset.color;
}));
