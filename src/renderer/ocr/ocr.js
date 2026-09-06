// ── Tanı: ilk fare olayı sayfaya NE ZAMAN ulaştı? ──────────────────────────
// "Fare hiçbir şey yapmıyor, bir kere tıklayınca düzeliyor" bildirimi için.
// Overlay hazır olduğu andan itibaren ölçülüyor ve oturum başına YALNIZ BİR
// satır yazılıyor; olay hiç gelmezse satır da hiç çıkmıyor — o da bir cevap.
(function () {
    let t0 = performance.now();
    let bildirildi = { mousemove: false, mousedown: false };
    const bildir = (tur) => {
        if (bildirildi[tur]) return;
        bildirildi[tur] = true;
        if (window.api && window.api.sendDebugLog) {
            window.api.sendDebugLog('ilk ' + tur + ' sayfaya ulaştı: +' + Math.round(performance.now() - t0) + ' ms');
        }
    };
    ['mousemove', 'mousedown'].forEach((tur) => {
        window.addEventListener(tur, () => bildir(tur), { capture: true, passive: true });
    });
    // Sayaç, görüntü gelip overlay GÖRÜNÜR olduğunda sıfırlanıyor: ondan öncesi
    // pencere gizliyken geçen süre ve ölçüme girmemeli.
    if (window.api && window.api.onCaptureScreen) {
        const orijinal = window.api.onCaptureScreen;
        window.api.onCaptureScreen = function (cb) {
            return orijinal.call(window.api, function () {
                t0 = performance.now();
                bildirildi = { mousemove: false, mousedown: false };
                // Her overlay kendini duyuruyor. Çok monitörde iki overlay açılıyor
                // ve hangisinin fare olayı ALMADIĞI ancak satırın YOKLUĞUNDAN
                // anlaşılıyor — o yüzden "hazırım" satırı şart.
                if (window.api && window.api.sendDebugLog) {
                    window.api.sendDebugLog('overlay hazır, fare bekleniyor');
                }
                return cb.apply(this, arguments);
            });
        };
    }
})();

const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const overlay = document.getElementById('overlay');

let isSelecting = false;
let startX = 0, startY = 0;
let scaleX = 1, scaleY = 1;
// A capture targets one monitor: starting a selection here clears the other monitors'
// selections; this one clears via onCaptureReset when another starts. Newest wins.

// Kept for repaints: assigning canvas.width/height WIPES the canvas, so a resize after the
// capture landed used to erase the screenshot (and drop it back to logical resolution). The
// overlay window is transparent, so the live desktop showed through and nothing looked
// wrong — the scan just ran on an empty image.
let screenBitmap = null;

function paintScreen() {
    if (!screenBitmap) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(screenBitmap, 0, 0, canvas.width, canvas.height);
}

function resizeCanvas() {
    if (screenBitmap) {
        // Capture loaded: keep its physical resolution, only restretch and rescale.
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        scaleX = canvas.width / window.innerWidth;
        scaleY = canvas.height / window.innerHeight;
        return;
    }
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

    screenBitmap = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    reset();

    const finish = () => {
        overlay.style.display = 'block';
        document.body.classList.add('ready');
        window.api.notifyReady();
    };

    // An unusable screenshot must never open the overlay — the screen layer would be empty
    // (invisible behind the transparent window), and the scan would run on a blank image
    // ("Metin bulunamadı"). Self-heal: ask main to re-capture and re-send; this handler
    // re-runs with the fresh data. The window is still hidden, so the retry is invisible.
    const fail = (reason) => {
        window.api.sendDebugLog('OCR: capture unusable (' + reason + ') — requesting re-capture');
        window.api.retryCapture();
    };

    // Binary PNG buffer from main — decode via ImageBitmap (no base64/string round-trip).
    if (imageData && imageData.byteLength) {
        createImageBitmap(new Blob([imageData], { type: 'image/png' })).then((bmp) => {
            screenBitmap = bmp; // kept (not closed) so resizeCanvas can repaint from it
            paintScreen();
            finish();
        }).catch((err) => fail('çözümlenemedi: ' + ((err && err.message) || 'bilinmeyen hata')));
    } else if (typeof imageData === 'string' && imageData.length > 100) {
        const img = new Image();
        img.onload = () => {
            screenBitmap = img;
            paintScreen();
            finish();
        };
        img.onerror = () => fail('görüntü yüklenemedi');
        img.src = imageData;
    } else {
        fail('boş görüntü verisi');
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
