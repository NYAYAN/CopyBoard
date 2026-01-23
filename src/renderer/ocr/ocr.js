const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const overlay = document.getElementById('overlay');

let isSelecting = false;
let startX = 0, startY = 0;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Capture & Initialize ---
window.api.onCaptureScreen((imageDataUrl) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setTimeout(() => window.api.notifyReady(), 50);
    };
    img.src = imageDataUrl;
    reset();
});

function reset() {
    isSelecting = false;
    selectionBox.style.display = 'none';
    selectionBox.style.width = selectionBox.style.height = '0px';
    overlay.style.display = 'block';
}

// --- Interaction Logic ---
window.addEventListener('mousedown', (e) => {
    reset();
    isSelecting = true;
    overlay.style.display = 'none';
    startX = e.clientX;
    startY = e.clientY;
    selectionBox.style.left = startX + 'px';
    selectionBox.style.top = startY + 'px';
    selectionBox.style.display = 'block'; // hidden yerine display kontrol et
});

window.addEventListener('mousemove', (e) => {
    if (!isSelecting) return;
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selectionBox.style.width = w + 'px';
    selectionBox.style.height = h + 'px';
    selectionBox.style.left = Math.min(e.clientX, startX) + 'px';
    selectionBox.style.top = Math.min(e.clientY, startY) + 'px';
});

window.addEventListener('mouseup', () => {
    if (!isSelecting) return;
    isSelecting = false;
    const rect = selectionBox.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) { reset(); return; }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = rect.width;
    tempCanvas.height = rect.height;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.drawImage(canvas, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);

    // OCR işlemi için gönder
    window.api.sendOCR(tempCanvas.toDataURL('image/png'));
});

// ESC key to close
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.api.closeSnipper();
});
