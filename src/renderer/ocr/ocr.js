const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const overlay = document.getElementById('overlay');

let isSelecting = false;
let startX = 0, startY = 0;
let scaleX = 1, scaleY = 1;
// A capture targets one monitor: starting a selection here clears the other monitors'
// selections; this one clears via onCaptureReset when another starts. Newest wins.

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Another monitor started a selection → clear ours (back to full dim), stay interactive.
window.api.onCaptureReset(() => reset());

// --- Capture & Initialize ---
window.api.onCaptureScreen((imageData, mode, sourceId, quality, captureWidth, captureHeight) => {
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

    const finish = () => {
        overlay.style.display = 'block';
        document.body.classList.add('ready');
        window.api.notifyReady();
    };

    // Binary PNG buffer from main — decode via ImageBitmap (no base64/string round-trip).
    if (imageData && imageData.byteLength) {
        createImageBitmap(new Blob([imageData], { type: 'image/png' })).then((bmp) => {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
            if (bmp.close) bmp.close();
            finish();
        }).catch(() => finish());
    } else if (typeof imageData === 'string' && imageData.length > 100) {
        const img = new Image();
        img.onload = () => {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            finish();
        };
        img.src = imageData;
    } else {
        setTimeout(finish, 50);
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
    window.api.claimCaptureMonitor(); // new selection → clear other monitors' selections
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
