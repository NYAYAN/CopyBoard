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
window.api.onCaptureScreen((dataUrl, mode, sourceId) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    reset();

    overlay.style.display = 'none';

    requestAnimationFrame(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sourceId,
                        minWidth: canvas.width,
                        maxWidth: canvas.width,
                        minHeight: canvas.height,
                        maxHeight: canvas.height
                    }
                }
            });

            const video = document.createElement('video');
            video.style.cssText = 'position:absolute;top:-10000px;left:-10000px;';
            video.srcObject = stream;

            video.onloadeddata = () => {
                video.play();

                const drawAndShow = () => {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    stream.getTracks().forEach(track => track.stop());

                    overlay.style.display = 'block';
                    document.body.classList.add('ready');
                    window.api.notifyReady();
                };

                if ('requestVideoFrameCallback' in video) {
                    video.requestVideoFrameCallback(drawAndShow);
                } else {
                    requestAnimationFrame(() => requestAnimationFrame(drawAndShow));
                }
            };
        } catch (err) {
            console.error('OCR High-quality capture failed:', err);
            const img = new Image();
            img.onload = () => {
                ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, canvas.width, canvas.height);
                overlay.style.display = 'block';
                document.body.classList.add('ready');
                setTimeout(() => window.api.notifyReady(), 50);
            };
            img.src = dataUrl;
        }
    });
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
