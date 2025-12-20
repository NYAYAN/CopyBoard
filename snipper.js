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

let isSelecting = false;
let isDrawing = false;
let isMoving = false;
let isDraggingText = false;
let isResizing = false;
let activeHandle = null;
let resizeStartRect = null;
let selectionRect = null;
let activeTool = null;
let startX = 0, startY = 0;
let dragOffX = 0, dragOffY = 0;
let savedImageData = null;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawCanvas.width = window.innerWidth;
    drawCanvas.height = window.innerHeight;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.strokeStyle = '#ff0000';
    drawCtx.lineWidth = 3;
    drawCtx.font = "20px Arial";
    drawCtx.fillStyle = "#ff0000";
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Capture & Initialize ---
window.api.onCaptureScreen((imageDataUrl) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    resetUI();

    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setTimeout(() => window.api.notifyReady(), 50);
    };
    img.src = imageDataUrl;
});

function resetUI() {
    isSelecting = isDrawing = isMoving = isDraggingText = isResizing = false;
    selectionRect = activeTool = null;
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

    selectionBox.style.display = 'none';
    selectionBox.classList.add('hidden');
    textInputContainer.style.display = 'none';
    textInput.value = '';
    toolbar.style.display = 'none';
    overlay.style.display = 'block';
    document.body.classList.remove('drawing');
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
}

// --- Interaction Logic ---
window.addEventListener('mousedown', (e) => {
    if (e.target.closest('.toolbar')) return;

    if (e.target === textDragHandle) {
        isDraggingText = true;
        const rect = textInputContainer.getBoundingClientRect();
        dragOffX = e.clientX - rect.left;
        dragOffY = e.clientY - rect.top;
        return;
    }

    if (selectionRect) {
        if (e.target.classList.contains('resize-handle')) {
            isResizing = true;
            activeHandle = e.target.dataset.handle;
            const b = selectionBox.getBoundingClientRect();
            resizeStartRect = { left: b.left, top: b.top, width: b.width, height: b.height };
            startX = e.clientX;
            startY = e.clientY;
            toolbar.style.display = 'none';
            return;
        }

        if (activeTool) {
            const isInside = (
                e.clientX >= selectionRect.x && e.clientX <= selectionRect.x + selectionRect.w &&
                e.clientY >= selectionRect.y && e.clientY <= selectionRect.y + selectionRect.h
            );
            if (!isInside) return;

            if (activeTool === 'text') {
                textInputContainer.style.left = e.clientX + 'px';
                textInputContainer.style.top = (e.clientY - 20) + 'px';
                textInputContainer.style.display = 'flex';
                textInputContainer.classList.remove('hidden');
                setTimeout(() => textInput.focus(), 0);
                return;
            }

            isDrawing = true;
            startX = e.clientX;
            startY = e.clientY;

            if (activeTool === 'pen') {
                drawCtx.beginPath();
                drawCtx.moveTo(startX, startY);
            } else {
                savedImageData = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
            }
            return;
        }

        if (e.target === selectionBox) {
            isMoving = true;
            const rect = selectionBox.getBoundingClientRect();
            dragOffX = e.clientX - rect.left;
            dragOffY = e.clientY - rect.top;
            toolbar.style.display = 'none';
            return;
        }
    }

    if (!activeTool) {
        resetUI();
        isSelecting = true;
        overlay.style.display = 'none';
        startX = e.clientX;
        startY = e.clientY;
        selectionBox.style.width = selectionBox.style.height = '0px';
        selectionBox.style.left = startX + 'px';
        selectionBox.style.top = startY + 'px';
        selectionBox.style.display = 'block';
        selectionBox.classList.remove('hidden');
    }
});

window.addEventListener('mousemove', (e) => {
    if (isDraggingText) {
        let newLeft = e.clientX - dragOffX;
        let newTop = e.clientY - dragOffY;
        newLeft = Math.max(selectionRect.x, Math.min(newLeft, selectionRect.x + selectionRect.w - textInputContainer.offsetWidth));
        newTop = Math.max(selectionRect.y, Math.min(newTop, selectionRect.y + selectionRect.h - textInputContainer.offsetHeight));
        textInputContainer.style.left = newLeft + 'px';
        textInputContainer.style.top = newTop + 'px';
    } else if (isResizing) {
        let dx = e.clientX - startX;
        let dy = e.clientY - startY;
        let { left, top, width, height } = resizeStartRect;

        if (activeHandle.includes('e')) width += dx;
        if (activeHandle.includes('s')) height += dy;
        if (activeHandle.includes('w')) { left += dx; width -= dx; }
        if (activeHandle.includes('n')) { top += dy; height -= dy; }

        if (width < 20) { if (activeHandle.includes('w')) left = resizeStartRect.left + resizeStartRect.width - 20; width = 20; }
        if (height < 20) { if (activeHandle.includes('n')) top = resizeStartRect.top + resizeStartRect.height - 20; height = 20; }

        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';
        selectionBox.style.left = left + 'px';
        selectionBox.style.top = top + 'px';
    } else if (isMoving) {
        let newLeft = Math.max(0, Math.min(e.clientX - dragOffX, window.innerWidth - selectionBox.offsetWidth));
        let newTop = Math.max(0, Math.min(e.clientY - dragOffY, window.innerHeight - selectionBox.offsetHeight));
        selectionBox.style.left = newLeft + 'px';
        selectionBox.style.top = newTop + 'px';
    } else if (isSelecting) {
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        selectionBox.style.width = w + 'px';
        selectionBox.style.height = h + 'px';
        selectionBox.style.left = Math.min(e.clientX, startX) + 'px';
        selectionBox.style.top = Math.min(e.clientY, startY) + 'px';
    } else if (isDrawing) {
        drawCtx.save();
        const clipPath = new Path2D();
        clipPath.rect(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
        drawCtx.clip(clipPath);

        if (activeTool === 'pen') {
            drawCtx.beginPath();
            drawCtx.moveTo(startX, startY);
            drawCtx.lineTo(e.clientX, e.clientY);
            drawCtx.stroke();
            startX = e.clientX;
            startY = e.clientY;
        } else {
            drawCtx.putImageData(savedImageData, 0, 0);
            const w = e.clientX - startX;
            const h = e.clientY - startY;
            if (activeTool === 'rect') drawCtx.strokeRect(startX, startY, w, h);
            else if (activeTool === 'circle') {
                drawCtx.beginPath();
                drawCtx.ellipse(startX + w / 2, startY + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, 2 * Math.PI);
                drawCtx.stroke();
            } else if (activeTool === 'arrow') drawArrow(drawCtx, startX, startY, e.clientX, e.clientY);
        }
        drawCtx.restore();
    }
});

window.addEventListener('mouseup', () => {
    if (isResizing || isMoving || isSelecting) {
        const rect = selectionBox.getBoundingClientRect();
        if (isSelecting && (rect.width < 10 || rect.height < 10)) { resetUI(); return; }
        selectionRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
        showToolbar(rect);
    }
    isDraggingText = isResizing = isMoving = isSelecting = isDrawing = false;
});

function showToolbar(rect) {
    toolbar.style.display = 'flex';
    let top = rect.bottom + 10;
    let left = rect.right - toolbar.offsetWidth;
    if (left < rect.left) left = rect.left;
    if (top + toolbar.offsetHeight > window.innerHeight) top = rect.top - toolbar.offsetHeight - 10;
    toolbar.style.top = top + 'px';
    toolbar.style.left = left + 'px';
}

function drawArrow(ctx, fromx, fromy, tox, toy) {
    const headlen = 10;
    const angle = Math.atan2(toy - fromy, tox - fromx);
    ctx.beginPath();
    ctx.moveTo(fromx, fromy);
    ctx.lineTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
}

document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (activeTool === tool) {
            activeTool = null;
            document.body.classList.remove('drawing');
            btn.classList.remove('active');
            if (tool === 'text') { textInputContainer.style.display = 'none'; textInput.value = ''; }
        } else {
            if (activeTool === 'text') { textInputContainer.style.display = 'none'; textInput.value = ''; }
            activeTool = tool;
            document.body.classList.add('drawing');
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
    });
});

function getFinalImage() {
    if (!selectionRect) return null;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = selectionRect.w;
    tempCanvas.height = selectionRect.h;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.drawImage(canvas, selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h, 0, 0, selectionRect.w, selectionRect.h);
    tCtx.drawImage(drawCanvas, selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h, 0, 0, selectionRect.w, selectionRect.h);
    return tempCanvas.toDataURL('image/png');
}

document.getElementById('btn-close').addEventListener('click', () => window.api.closeSnipper());
document.getElementById('btn-copy').addEventListener('click', () => {
    const dataUrl = getFinalImage();
    if (dataUrl) window.api.sendCopyImage(dataUrl);
});
document.getElementById('btn-save').addEventListener('click', () => {
    const dataUrl = getFinalImage();
    if (dataUrl) window.api.sendSaveImage(dataUrl);
});

textInput.addEventListener('input', () => {
    textInput.style.height = 'auto';
    textInput.style.height = textInput.scrollHeight + 'px';
});

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = textInput.value.trim();
        if (text) {
            drawCtx.save();
            drawCtx.beginPath();
            drawCtx.rect(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
            drawCtx.clip();
            const inputRect = textInput.getBoundingClientRect();
            let x = inputRect.left + 10, y = inputRect.top + 22;
            textInput.value.split('\n').forEach(line => { drawCtx.fillText(line, x, y); y += 24; });
            drawCtx.restore();
        }
        textInputContainer.style.display = 'none';
        textInput.value = '';
        textInput.blur();
    } else if (e.key === 'Escape') {
        textInputContainer.style.display = 'none';
        textInput.value = '';
    }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.closeSnipper(); });
document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
        document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        drawCtx.strokeStyle = drawCtx.fillStyle = dot.dataset.color;
    });
});
