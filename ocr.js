const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const overlay = document.getElementById('overlay');

let isSelecting = false;
let startX = 0, startY = 0;

// Resize canvas
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Receive screenshot
window.api.onCaptureScreen((imageDataUrl) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        window.api.notifyReady();
    };
    img.src = imageDataUrl;
    reset();
});

function reset() {
    isSelecting = false;
    selectionBox.classList.add('hidden');
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    overlay.style.display = 'block';
}

window.addEventListener('mousedown', (e) => {
    reset();
    isSelecting = true;
    overlay.style.display = 'none';
    startX = e.clientX;
    startY = e.clientY;

    selectionBox.style.left = startX + 'px';
    selectionBox.style.top = startY + 'px';
    selectionBox.classList.remove('hidden');
});

window.addEventListener('mousemove', (e) => {
    if (!isSelecting) return;

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
});

window.addEventListener('mouseup', () => {
    if (!isSelecting) return;
    isSelecting = false;

    const rect = selectionBox.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
        reset();
        return;
    }

    // Capture and send
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = rect.width;
    tempCanvas.height = rect.height;
    const tCtx = tempCanvas.getContext('2d');

    tCtx.drawImage(canvas,
        rect.left, rect.top, rect.width, rect.height,
        0, 0, rect.width, rect.height
    );

    const dataUrl = tempCanvas.toDataURL('image/png');
    window.api.sendCrop(dataUrl);
});

// ESC key to close
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        window.api.closeSnipper();
    }
});
