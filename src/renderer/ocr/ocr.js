const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const overlay = document.getElementById('overlay');

let isSelecting = false;
let startX = 0, startY = 0;
let scaleX = 1, scaleY = 1;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Capture & Initialize ---
window.api.onCaptureScreen((dataUrl, mode, sourceId, quality, captureWidth, captureHeight) => {
    const logicalW = window.innerWidth;
    const logicalH = window.innerHeight;
    const physW = captureWidth || logicalW;
    const physH = captureHeight || logicalH;

    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = logicalW + 'px';
    canvas.style.height = logicalH + 'px';
    scaleX = physW / logicalW;
    scaleY = physH / logicalH;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    reset();

    if (dataUrl && dataUrl.length > 100) {
        const img = new Image();
        img.onload = () => {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            overlay.style.display = 'block';
            document.body.classList.add('ready');
            window.api.notifyReady();
        };
        img.src = dataUrl;
    } else {
        overlay.style.display = 'block';
        document.body.classList.add('ready');
        setTimeout(() => window.api.notifyReady(), 50);
    }
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

    const srcX = rect.left * scaleX;
    const srcY = rect.top * scaleY;
    const srcW = rect.width * scaleX;
    const srcH = rect.height * scaleY;
    const cropW = Math.round(srcW);
    const cropH = Math.round(srcH);
    if (cropW < 1 || cropH < 1) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cropW;
    tempCanvas.height = cropH;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.drawImage(canvas, srcX, srcY, srcW, srcH, 0, 0, cropW, cropH);

    window.api.sendOCR(tempCanvas.toDataURL('image/png'));
});

// ESC key to close
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.api.closeSnipper();
});
