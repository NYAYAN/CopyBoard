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
let isMoving = false; // New: Moving selection
let isDraggingText = false; // New: Dragging text input
let isResizing = false; // New: Resizing selection
let activeHandle = null; // New: Which handle is being dragged
let resizeStartRect = null; // { left, top, width, height }
let selectionRect = null; // { x, y, w, h }
let activeTool = null; // 'pen', 'rect', 'circle', 'text', 'arrow'
let startX = 0, startY = 0;
let dragOffX = 0, dragOffY = 0; // For moving
let savedImageData = null; // For shape preview

// Resize canvases
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawCanvas.width = window.innerWidth;
    drawCanvas.height = window.innerHeight;

    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.strokeStyle = '#ff0000'; // Default red
    drawCtx.lineWidth = 3;
    drawCtx.font = "20px Arial";
    drawCtx.fillStyle = "#ff0000";
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Receive screenshot
window.api.onCaptureScreen((imageDataUrl) => {
    // Clear main canvas to prevent ghosts from PREVIOUS capture session
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        window.api.notifyReady();
    };
    img.src = imageDataUrl;
    reset(); // Reset UI state but keep the newly drawn background
});

function reset() {
    isSelecting = false;
    isDrawing = false;
    isMoving = false;
    isDraggingText = false;
    isResizing = false;
    selectionRect = null;
    activeTool = null;

    // Forcefully reset selection box (prevent ghost from previous session)
    selectionBox.style.display = ''; // Reset inline style (let CSS class control it)
    selectionBox.style.left = '0px';
    selectionBox.style.top = '0px';
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.classList.add('hidden');

    textInputContainer.classList.add('hidden');
    textInputContainer.style.display = 'none'; // Force hide
    textInputContainer.style.left = '-1000px'; // Move off-screen
    textInput.value = '';

    toolbar.style.display = 'none'; // Force hide
    overlay.style.display = 'block'; // Show darkening

    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

    document.body.classList.remove('drawing');
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
}

// --- Interaction Logic ---

window.addEventListener('mousedown', (e) => {
    // If clicking on toolbar, ignore
    if (e.target.closest('.toolbar')) return;

    // If clicking on text drag handle, start dragging the container
    if (e.target === textDragHandle) {
        isDraggingText = true;
        const rect = textInputContainer.getBoundingClientRect();
        dragOffX = e.clientX - rect.left;
        dragOffY = e.clientY - rect.top;
        return;
    }

    if (selectionRect) {
        // RESIZING LOGIC (Priority)
        if (e.target.classList.contains('resize-handle')) {
            isResizing = true;
            activeHandle = e.target.dataset.handle;
            const b = selectionBox.getBoundingClientRect();
            resizeStartRect = { left: b.left, top: b.top, width: b.width, height: b.height };
            startX = e.clientX;
            startY = e.clientY;
            toolbar.style.display = 'none'; // Hide toolbar while resizing
            return;
        }

        // DRAWING MODE LOGIC

        // If a tool is selected, we draw
        if (activeTool) {
            // Check if click is inside selectionRect
            const isInside = (
                e.clientX >= selectionRect.x &&
                e.clientX <= selectionRect.x + selectionRect.w &&
                e.clientY >= selectionRect.y &&
                e.clientY <= selectionRect.y + selectionRect.h
            );

            if (!isInside) return; // Block drawing start outside selection

            // TEXT TOOL SPECIAL CASE
            if (activeTool === 'text') {
                // Show text input container at click position
                textInputContainer.style.left = e.clientX + 'px';
                textInputContainer.style.top = (e.clientY - 20) + 'px';
                textInputContainer.style.display = 'flex'; // Ensure visible
                textInputContainer.classList.remove('hidden');
                textInput.value = '';

                // Force focus with a micro-task to ensure it works
                setTimeout(() => textInput.focus(), 0);

                // Store position for later (relative to canvas)
                textInputContainer.dataset.x = e.clientX;
                textInputContainer.dataset.y = (e.clientY - 20);
                return;
            }

            isDrawing = true;
            startX = e.clientX;
            startY = e.clientY;

            if (activeTool === 'pen') {
                drawCtx.beginPath();
                drawCtx.moveTo(startX, startY);
            } else {
                // Save state for shape preview
                savedImageData = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
            }
            return;
        }

        // If NO tool selected, checks if we clicked inside selection box to MOVE
        if (e.target === selectionBox) {
            isMoving = true;
            const rect = selectionBox.getBoundingClientRect();
            dragOffX = e.clientX - rect.left;
            dragOffY = e.clientY - rect.top;
            toolbar.style.display = 'none'; // Hide toolbar while moving
            return;
        }
    }

    // Default: Start Selecting (Click outside or first time)
    if (!activeTool) {
        // If we are drawing, don't reset. But here activeTool is null.
        reset(); // Clear previous
        isSelecting = true;
        overlay.style.display = 'none'; // Hide overlay when selecting
        startX = e.clientX;
        startY = e.clientY;
        selectionBox.style.left = startX + 'px';
        selectionBox.style.top = startY + 'px';
        selectionBox.style.width = '0px';
        selectionBox.style.height = '0px';
        selectionBox.classList.remove('hidden');
    }
});

window.addEventListener('mousemove', (e) => {
    if (isDraggingText) {
        // Drag text input container
        let newLeft = e.clientX - dragOffX;
        let newTop = e.clientY - dragOffY;

        // Constraint within selectionRect
        if (newLeft < selectionRect.x) newLeft = selectionRect.x;
        if (newTop < selectionRect.y) newTop = selectionRect.y;
        if (newLeft + textInputContainer.offsetWidth > selectionRect.x + selectionRect.w) {
            newLeft = selectionRect.x + selectionRect.w - textInputContainer.offsetWidth;
        }
        if (newTop + textInputContainer.offsetHeight > selectionRect.y + selectionRect.h) {
            newTop = selectionRect.y + selectionRect.h - textInputContainer.offsetHeight;
        }

        textInputContainer.style.left = newLeft + 'px';
        textInputContainer.style.top = newTop + 'px';

    } else if (isResizing) {
        // Resizing logic - robust delta based
        let dx = e.clientX - startX;
        let dy = e.clientY - startY;

        let left = resizeStartRect.left;
        let top = resizeStartRect.top;
        let width = resizeStartRect.width;
        let height = resizeStartRect.height;

        if (activeHandle.includes('e')) width += dx;
        if (activeHandle.includes('s')) height += dy;
        if (activeHandle.includes('w')) {
            left += dx;
            width -= dx;
        }
        if (activeHandle.includes('n')) {
            top += dy;
            height -= dy;
        }

        // Min size check (and prevent flip)
        if (width < 20) {
            if (activeHandle.includes('w')) left = resizeStartRect.left + resizeStartRect.width - 20;
            width = 20;
        }
        if (height < 20) {
            if (activeHandle.includes('n')) top = resizeStartRect.top + resizeStartRect.height - 20;
            height = 20;
        }

        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';
        selectionBox.style.left = left + 'px';
        selectionBox.style.top = top + 'px';

    } else if (isMoving) {
        // Update selection box position
        let newLeft = e.clientX - dragOffX;
        let newTop = e.clientY - dragOffY;

        // Bounds check (optional)
        if (newLeft < 0) newLeft = 0;
        if (newTop < 0) newTop = 0;
        if (newLeft + selectionBox.offsetWidth > window.innerWidth) newLeft = window.innerWidth - selectionBox.offsetWidth;
        if (newTop + selectionBox.offsetHeight > window.innerHeight) newTop = window.innerHeight - selectionBox.offsetHeight;

        selectionBox.style.left = newLeft + 'px';
        selectionBox.style.top = newTop + 'px';

    } else if (isSelecting) {
        const currentX = e.clientX;
        const currentY = e.clientY;

        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);
        const left = Math.min(currentX, startX);
        const top = Math.min(currentY, startY);

        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';
        selectionBox.style.left = left + 'px';
        selectionBox.style.top = top + 'px';

    } else if (isDrawing) {
        drawCtx.save();
        // Clip to selection area
        drawCtx.beginPath();
        drawCtx.rect(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
        drawCtx.clip();

        if (activeTool === 'pen') {
            drawCtx.lineTo(e.clientX, e.clientY);
            drawCtx.stroke();
        } else if (activeTool === 'rect') {
            drawCtx.putImageData(savedImageData, 0, 0);
            const w = e.clientX - startX;
            const h = e.clientY - startY;
            drawCtx.strokeRect(startX, startY, w, h);
        } else if (activeTool === 'circle') {
            drawCtx.putImageData(savedImageData, 0, 0);
            const w = e.clientX - startX;
            const h = e.clientY - startY;
            drawCtx.beginPath();
            drawCtx.ellipse(startX + w / 2, startY + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, 2 * Math.PI);
            drawCtx.stroke();
        } else if (activeTool === 'arrow') {
            drawCtx.putImageData(savedImageData, 0, 0);
            drawArrow(drawCtx, startX, startY, e.clientX, e.clientY);
        }
        drawCtx.restore();
    }
});

window.addEventListener('mouseup', (e) => {
    if (isDraggingText) {
        isDraggingText = false;
        // Update stored position
        const rect = textInputContainer.getBoundingClientRect();
        textInputContainer.dataset.x = rect.left;
        textInputContainer.dataset.y = rect.top;

    } else if (isResizing) {
        isResizing = false;
        activeHandle = null;
        const rect = selectionBox.getBoundingClientRect();
        selectionRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
        showToolbar(rect);

    } else if (isMoving) {
        isMoving = false;
        // Update selectionRect
        const rect = selectionBox.getBoundingClientRect();
        selectionRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
        showToolbar(rect); // Bring toolbar back

    } else if (isSelecting) {
        isSelecting = false;
        const rect = selectionBox.getBoundingClientRect();

        if (rect.width < 10 || rect.height < 10) {
            reset();
            return;
        }

        selectionRect = {
            x: rect.left,
            y: rect.top,
            w: rect.width,
            h: rect.height
        };

        // Draw Mode: Show toolbar
        showToolbar(rect);
    } else if (isDrawing) {
        isDrawing = false;
        savedImageData = null;
    }
});

function showToolbar(rect) {
    toolbar.style.display = 'flex'; // Show it now
    toolbar.classList.remove('hidden'); // Just in case

    // Position toolbar near bottom-right of selection
    let top = rect.bottom + 10;
    let left = rect.right - toolbar.offsetWidth;

    if (left < rect.left) left = rect.left;
    if (top + toolbar.offsetHeight > window.innerHeight) top = rect.top - toolbar.offsetHeight - 10;

    toolbar.style.top = top + 'px';
    toolbar.style.left = left + 'px';
}

function drawArrow(ctx, fromx, fromy, tox, toy) {
    const headlen = 10;
    const dx = tox - fromx;
    const dy = toy - fromy;
    const angle = Math.atan2(dy, dx);

    ctx.beginPath();
    ctx.moveTo(fromx, fromy);
    ctx.lineTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
}

// --- Tools ---

document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // Toggle tool
        const tool = btn.dataset.tool;
        if (activeTool === tool) {
            activeTool = null;
            document.body.classList.remove('drawing'); // Pass clicks back to logic
            btn.classList.remove('active');

            // If we're closing the text tool, hide the input
            if (tool === 'text') {
                textInputContainer.classList.add('hidden');
                textInputContainer.style.display = 'none';
                textInput.value = '';
            }
        } else {
            // Before switching to a new tool, if current was text, hide it
            if (activeTool === 'text') {
                textInputContainer.classList.add('hidden');
                textInputContainer.style.display = 'none';
            }

            activeTool = tool;
            document.body.classList.add('drawing');
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
    });
});

// --- Actions ---

function getFinalImage() {
    if (!selectionRect) return null;

    // Combine canvases
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = selectionRect.w;
    tempCanvas.height = selectionRect.h;
    const tCtx = tempCanvas.getContext('2d');

    // Draw screen
    tCtx.drawImage(canvas,
        selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h,
        0, 0, selectionRect.w, selectionRect.h);

    // Draw annotations
    tCtx.drawImage(drawCanvas,
        selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h,
        0, 0, selectionRect.w, selectionRect.h);

    return tempCanvas.toDataURL('image/png');
}

document.getElementById('btn-close').addEventListener('click', () => {
    window.api.closeSnipper();
});

document.getElementById('btn-copy').addEventListener('click', () => {
    const dataUrl = getFinalImage();
    if (dataUrl) {
        window.api.sendCopyImage(dataUrl);
    }
});

document.getElementById('btn-save').addEventListener('click', () => {
    // Save Clicked
    const dataUrl = getFinalImage();
    if (dataUrl) {
        // Send save request. Window will stay open.
        window.api.sendSaveImage(dataUrl);
    }
});

// Textarea auto-resize logic
textInput.addEventListener('input', () => {
    textInput.style.height = 'auto';
    textInput.style.height = textInput.scrollHeight + 'px';
});

// Text input Enter key handler
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
            const x = inputRect.left + 10;
            let y = inputRect.top + 22;

            const lines = textInput.value.split('\n');
            const lineHeight = 24;

            lines.forEach((line) => {
                drawCtx.fillText(line, x, y);
                y += lineHeight;
            });
            drawCtx.restore();
        }
        textInputContainer.classList.add('hidden');
        textInputContainer.style.display = 'none';
        textInput.value = '';
        textInput.style.height = 'auto'; // Reset height
        textInput.blur(); // NEW: Remove focus to be safe
    } else if (e.key === 'Escape') {
        textInputContainer.classList.add('hidden');
        textInputContainer.style.display = 'none';
        textInput.value = '';
        textInput.style.height = 'auto'; // Reset height
    }
});

// ESC key to close
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        window.api.closeSnipper();
    }
});

// Color dots logic
document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
        document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        const color = dot.dataset.color;
        drawCtx.strokeStyle = color;
        drawCtx.fillStyle = color;
    });
});
