const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const overlay = document.getElementById('overlay');
const btnRecord = document.getElementById('btn-record');
const btnStop = document.getElementById('btn-stop');
const btnClose = document.getElementById('btn-close');
const btnFullscreen = document.getElementById('btn-fullscreen');
const toolbar = document.getElementById('recorder-toolbar');
const timerElement = document.getElementById('timer');
const instruction = document.querySelector('.instruction');
const qualitySelect = document.getElementById('quality-select');
const qualityLabel = document.getElementById('quality-label');
const btnMic = document.getElementById('btn-mic');
const btnSystemAudio = document.getElementById('btn-system-audio');

const state = {
    isSelecting: false, isMoving: false, isResizing: false,
    activeHandle: null, resizeStartRect: null, selectionRect: null,
    startX: 0, startY: 0, dragOffX: 0, dragOffY: 0,
    mediaRecorder: null, recordedChunks: [], startTime: 0, timerInterval: null,
    sourceId: null, isRecording: false, videoQuality: 'high', lastIgnoreState: null,
    audioMicOn: false, audioSystemOn: false,
    micStream: null, sysStream: null, audioContext: null,
    dpr: window.devicePixelRatio || 1,
    captureWidth: null,
    captureHeight: null,
    scaleX: null,
    scaleY: null
};

// Retained so the frozen backdrop can be repainted: assigning canvas.width/height WIPES the
// canvas, and behind this transparent window the live desktop looks identical to the frozen
// shot — a late resize used to silently swap one for the other.
let screenBitmap = null;

function paintScreen() {
    if (!screenBitmap) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(screenBitmap, 0, 0, canvas.width, canvas.height);
}

function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    state.dpr = dpr;

    if (screenBitmap) {
        // Backdrop loaded: keep its physical resolution, only restretch and rescale.
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        state.scaleX = canvas.width / w;
        state.scaleY = canvas.height / h;
        return;
    }

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// A capture targets one monitor: starting a region selection here clears the other monitors'
// selections; this one clears via onCaptureReset when another monitor starts. Newest wins.
function resetSelection() {
    if (state.isRecording) return;
    state.selectionRect = null;
    state.isSelecting = state.isMoving = state.isResizing = false;
    selectionBox.style.display = 'none';
    selectionBox.classList.add('hidden');
    overlay.style.display = 'block';
    if (instruction) instruction.style.display = '';
    document.body.classList.remove('selecting');
}
window.api.onCaptureReset(() => resetSelection());

window.api.onCaptureScreen((imageData, mode, sourceId, quality, captureWidth, captureHeight, multiMonitor) => {
    state.sourceId = sourceId;
    state.videoQuality = quality || 'high';
    if (qualitySelect) qualitySelect.value = state.videoQuality;

    const logicalW = window.innerWidth;
    const logicalH = window.innerHeight;
    const physW = captureWidth || logicalW;
    const physH = captureHeight || logicalH;

    state.captureWidth = physW;
    state.captureHeight = physH;
    state.scaleX = physW / logicalW;
    state.scaleY = physH / logicalH;

    screenBitmap = null;
    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = logicalW + 'px';
    canvas.style.height = logicalH + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Auto-place a default 500x500 box ONLY on a single monitor. With multiple monitors,
    // leave every overlay empty (dimmed + "select area") so the user draws the region on
    // the ONE monitor they want — a default box on every screen makes it unclear which
    // monitor records.
    const finish = () => {
        if (!multiMonitor) applyDefaultSize();
        window.api.notifyReady();
    };

    // Unusable screenshot → self-heal like the snipper: ask main to re-capture and re-send
    // (this handler re-runs with the fresh data). Still hidden here, so it's invisible.
    // The backdrop is cosmetic for video — recording is a live stream — but a silent gap
    // would leave region selection running on the live desktop instead of the frozen frame.
    const fail = (reason) => {
        window.api.sendDebugLog('Recorder: capture unusable (' + reason + ') — requesting re-capture');
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

const dimensionsLabel = document.getElementById('dimensions-label');

function updateDimensions(w, h) {
    if (dimensionsLabel) {
        dimensionsLabel.textContent = `${Math.round(w)} x ${Math.round(h)}`;
    }
}

if (qualitySelect) {
    qualitySelect.addEventListener('change', (e) => {
        state.videoQuality = e.target.value;
        window.api.setVideoQuality(state.videoQuality);
    });
}

// --- Audio toggles (microphone + system/computer audio) ---
function updateAudioButtons() {
    if (btnMic) {
        btnMic.classList.toggle('active', !!state.audioMicOn);
        btnMic.setAttribute('aria-pressed', state.audioMicOn ? 'true' : 'false');
    }
    if (btnSystemAudio) {
        btnSystemAudio.classList.toggle('active', !!state.audioSystemOn);
        btnSystemAudio.setAttribute('aria-pressed', state.audioSystemOn ? 'true' : 'false');
    }
}

// Restore the last-used audio choices so the toolbar remembers them across captures.
if (window.api.getAudioSettings) {
    window.api.getAudioSettings().then((s) => {
        state.audioMicOn = !!(s && s.mic);
        state.audioSystemOn = !!(s && s.system);
        updateAudioButtons();
    }).catch(() => { });
}

if (btnMic) {
    btnMic.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.isRecording) return; // audio sources are locked in once recording starts
        state.audioMicOn = !state.audioMicOn;
        updateAudioButtons();
        if (window.api.setAudioMic) window.api.setAudioMic(state.audioMicOn);
    });
}

if (btnSystemAudio) {
    btnSystemAudio.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.isRecording) return;
        state.audioSystemOn = !state.audioSystemOn;
        updateAudioButtons();
        if (window.api.setAudioSystem) window.api.setAudioSystem(state.audioSystemOn);
    });
}

// --- Tıklama geçirgenliği: karar ana süreçte, geometri burada ---------------
//
// Kayıt sırasında overlay tıklama-geçirgen oluyor ki kullanıcı altındaki uygulamayla
// çalışabilsin; araç çubuğu ise tıklanabilir kalmalı. Electron bunu
// `setIgnoreMouseEvents(true, { forward: true })` ile yapıyordu — geçirgen ama
// mousemove alan pencere. Tauri'de `forward` yok ve macOS'ta geçirgen pencere hiç
// mousemove almıyor, yani araç çubuğuna geri dönmek imkânsız olurdu (BULGU F5-d).
//
// Artık yalnız araç çubuğunun dikdörtgeni bildiriliyor; imleci ana süreç yokluyor.
const TOOLBAR_HIT_PADDING = 20;

function reportToolbarHitArea() {
    if (!state.isRecording) {
        // Kayıt yokken overlay tamamen etkileşimli (seçim yapılıyor).
        window.api.setHitAreas([{ kind: 'everything' }]);
        return;
    }
    const tr = toolbar.getBoundingClientRect();
    window.api.setHitAreas([{
        kind: 'rect',
        x: tr.left - TOOLBAR_HIT_PADDING,
        y: tr.top - TOOLBAR_HIT_PADDING,
        w: tr.width + TOOLBAR_HIT_PADDING * 2,
        h: tr.height + TOOLBAR_HIT_PADDING * 2,
    }]);
}

// Araç çubuğu kayıt sırasında yer değiştirebiliyor; yerleşim değişimlerini yakala.
window.addEventListener('resize', reportToolbarHitArea);

window.addEventListener('mousedown', (e) => {
    if (state.isRecording) return;
    if (e.target.closest('.toolbar')) return;

    // Overlay üzerinde sürükleme: yeni seçim, seçimi taşıma, köşeden boyutlandırma.
    // Varsayılan davranış üçünde de metin seçimi başlatmak; hızlı sürüklerken WebKit
    // bunu mavi, sönümlenen bir vurguyla boyuyor. CSS'teki `user-select: none` zaten
    // engelliyor ama burada da kesiliyor — `preventDefault()` motordan bağımsız.
    // Araç çubuğu yukarıda elendiği için düğme odaklanması bozulmuyor.
    e.preventDefault();

    if (state.selectionRect) {
        if (e.target.classList.contains('resize-handle')) {
            state.isResizing = true; state.activeHandle = e.target.dataset.handle;
            const b = selectionBox.getBoundingClientRect();
            state.resizeStartRect = { left: b.left, top: b.top, width: b.width, height: b.height };
            state.startX = e.clientX; state.startY = e.clientY;
            document.body.classList.add('selecting');
            return;
        }
        if (e.target === selectionBox) {
            state.isMoving = true;
            const r = selectionBox.getBoundingClientRect();
            state.dragOffX = e.clientX - r.left; state.dragOffY = e.clientY - r.top;
            return;
        }
    }
    window.api.claimCaptureMonitor(); // new selection → clear other monitors' selections
    state.isSelecting = true;
    document.body.classList.add('selecting');
    state.startX = e.clientX; state.startY = e.clientY;
    selectionBox.style.width = selectionBox.style.height = '0px';
    selectionBox.style.left = state.startX + 'px'; selectionBox.style.top = state.startY + 'px';
    selectionBox.style.display = 'block'; selectionBox.classList.remove('hidden');
    overlay.style.display = 'none';
    if (instruction) instruction.style.display = 'none';
    updateDimensions(0, 0);
});

btnFullscreen.addEventListener('click', () => {
    if (state.isRecording) return;
    window.api.claimCaptureMonitor();
    state.selectionRect = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    selectionBox.style.left = '0px'; selectionBox.style.top = '0px';
    selectionBox.style.width = window.innerWidth + 'px'; selectionBox.style.height = window.innerHeight + 'px';
    selectionBox.style.display = 'block'; selectionBox.classList.remove('hidden');
    overlay.style.display = 'none';
    if (instruction) instruction.style.display = 'none';
    updateDimensions(window.innerWidth, window.innerHeight);
});

window.addEventListener('mousemove', (e) => {
    if (state.isRecording) return;
    if (state.isResizing) {
        let dx = e.clientX - state.startX, dy = e.clientY - state.startY;
        let { left, top, width, height } = state.resizeStartRect;
        if (state.activeHandle.includes('e')) width += dx;
        if (state.activeHandle.includes('s')) height += dy;
        if (state.activeHandle.includes('w')) { left += dx; width -= dx; }
        if (state.activeHandle.includes('n')) { top += dy; height -= dy; }
        width = Math.max(50, width);
        height = Math.max(50, height);
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
    }
});

window.addEventListener('mouseup', () => {
    if (state.isRecording) return;
    if (state.isResizing || state.isMoving || state.isSelecting) {
        const r = selectionBox.getBoundingClientRect();
        state.selectionRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    state.isResizing = state.isMoving = state.isSelecting = false;
    document.body.classList.remove('selecting');
});

btnClose.addEventListener('click', () => {
    if (state.isRecording) stopRecording();
    window.api.closeSnipper();
});

async function startRecording() {
    if (!state.selectionRect) return;
    try {
        // ── Kayıt motoru ana süreçte ─────────────────────────────────────────
        // Electron'da burada getUserMedia + canvas kırpma + MediaRecorder + saniyede
        // bir IPC chunk vardı. `chromeMediaSource` Electron'a özgü olduğu için
        // (WKWebView'da getDisplayMedia bile yok) yakalama, kırpma, encode ve mux
        // tamamen Rust'a taşındı. Kareler webview'a HİÇ uğramıyor.
        //
        // Ses de orada: ScreenCaptureKit sistem sesini doğrudan veriyor — macOS'ta
        // BlackHole gibi bir sanal aygıt artık gerekmiyor.
        const sx = state.scaleX != null ? state.scaleX : state.dpr;
        const sy = state.scaleY != null ? state.scaleY : state.dpr;
        const r = state.selectionRect;

        // Bölge FİZİKSEL piksele çevriliyor — ana süreç bu uzayda çalışıyor.
        const rect = {
            x: Math.max(0, Math.floor(r.x * sx)),
            y: Math.max(0, Math.floor(r.y * sy)),
            w: Math.max(2, Math.floor(r.w * sx)),
            h: Math.max(2, Math.floor(r.h * sy)),
        };
        if (window.api.sendDebugLog) {
            window.api.sendDebugLog(`Kayıt başlıyor: ${rect.w}x${rect.h} @ (${rect.x},${rect.y})`);
        }

        // ── Arayüz ÖNCE kayıt durumuna geçiyor ───────────────────────────────
        // `recordStart` motoru kuruyor: ses aygıtlarını açıyor, kodlayıcıyı hazırlıyor.
        // Bu birkaç saniye sürebiliyor ve o süre boyunca overlay hâlâ TÜM tıklamaları
        // yakalıyordu — kullanıcı "başlattım, 3-5 saniye ekrana tıklayamadım" diyordu.
        // Geçirgenliği beklemeden açıyoruz; SAYAÇ motor gerçekten başlayınca başlıyor,
        // yani gösterilen süre kaydın kendisiyle uyumlu kalıyor.
        state.isRecording = true;
        document.body.classList.add('is-recording');
        // Araç çubuğu kayıt durumuna geçiyor: Kaydı Başlat/tam ekran/kalite/ses düğmeleri
        // gizlenir, Durdur ve sayaç görünür. Bu blok porta geçişte düşmüştü — kayıt Rust
        // tarafında başlıyor ama düğme "Kaydı Başlat" olarak kalıyor, kullanıcı başlamadı
        // sanıp yeniden basıyordu (A13; günlükte 5 sn arayla iki "kayıt:" satırı).
        btnRecord.classList.add('hidden');
        btnFullscreen.classList.add('hidden');
        if (btnResetSize) btnResetSize.classList.add('hidden');
        if (qualitySelect) qualitySelect.classList.add('hidden');
        if (qualityLabel) qualityLabel.classList.add('hidden');
        if (btnMic) btnMic.classList.add('hidden');
        if (btnSystemAudio) btnSystemAudio.classList.add('hidden');
        btnStop.classList.remove('hidden');
        timerElement.classList.remove('hidden');
        timerElement.textContent = '00:00';
        selectionBox.classList.add('recording-border');
        canvas.style.pointerEvents = 'none';
        selectionBox.style.pointerEvents = 'none';
        document.querySelectorAll('.resize-handle').forEach(h => h.style.display = 'none');
        canvas.style.display = 'none';
        overlay.style.display = 'none';
        reportToolbarHitArea();

        await window.api.recordStart(rect);

        state.startTime = Date.now();
        state.timerInterval = setInterval(() => {
            const s = Math.floor((Date.now() - state.startTime) / 1000);
            timerElement.textContent = `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
        }, 1000);

    } catch (e) {
        console.error(t('Kayıt hatası:'), e);
        // Başlatma başarısız: arayüzü seçim durumuna geri al (yukarıda iyimser
        // davranıp kayıt durumuna geçmiştik).
        document.body.classList.remove('is-recording');
        btnStop.classList.add('hidden');
        timerElement.classList.add('hidden');
        btnRecord.classList.remove('hidden');
        btnFullscreen.classList.remove('hidden');
        if (btnResetSize) btnResetSize.classList.remove('hidden');
        if (qualitySelect) qualitySelect.classList.remove('hidden');
        if (qualityLabel) qualityLabel.classList.remove('hidden');
        if (btnMic) btnMic.classList.remove('hidden');
        if (btnSystemAudio) btnSystemAudio.classList.remove('hidden');
        selectionBox.classList.remove('recording-border');
        selectionBox.style.pointerEvents = 'auto';
        canvas.style.pointerEvents = '';
        canvas.style.display = 'block';
        overlay.style.display = 'block';
        document.querySelectorAll('.resize-handle').forEach(h => h.style.display = 'block');
        state.isRecording = false;
        reportToolbarHitArea();   // overlay yeniden tamamen etkileşimli
        alert('Kayıt başlatılamadı: ' + (e && e.message ? e.message : e));
    }
}

function stopRecording() {
    state.isRecording = false;
    // Ana süreç akışı durduruyor, mux'un kapanmasını bekliyor ve kaydetme panelini
    // açıyor. Renderer'ın elinde tutulan kare/parça YOK.
    window.api.recordStop();
    clearInterval(state.timerInterval);
    document.body.classList.remove('is-recording');
    // Kayıt bitti: bu pencerenin kalan TEK işi kaydetme panelinin SAHİBİ olmak — panel
    // böylece kaydın yapıldığı monitörde ve önde açılıyor (bkz. `record_stop`). Sayfa
    // tamamen boşaltılıyor.
    //
    // Eski hâli seçim arayüzünü geri getiriyordu: karartma + bir dakika önce çekilmiş
    // donmuş ekran görüntüsü. Pencere gizlenmediği için kullanıcı bunu görüyor ve
    // "durdurunca ekran karardı, yeniden alan seçme geldi" diyordu (A14).
    toolbar.classList.add('hidden');
    btnStop.classList.add('hidden');
    timerElement.classList.add('hidden');
    selectionBox.classList.remove('recording-border');
    selectionBox.style.display = 'none';
    canvas.style.display = 'none';
    overlay.style.display = 'none';
    document.querySelectorAll('.resize-handle').forEach(h => h.style.display = 'none');
    // Görünmez ama hâlâ orada: her tıklama altındaki uygulamaya geçsin.
    window.api.setHitAreas([]);
    // Mux'un dosyayı kapatması bir dakikalık kayıtta ~1,3 sn sürüyor; o boşlukta hiçbir
    // şey olmaması "durdurunca takılıyor" olarak görülüyordu. Panel açılmak üzereyken
    // ana süreç `record-save-ready` yolluyor ve bu yazı kalkıyor.
    if (instruction) {
        instruction.textContent = t('Video hazırlanıyor…');
        instruction.classList.remove('hidden');
        instruction.style.display = '';
    }
}

window.api.onRecordSaveReady(() => {
    if (instruction) instruction.style.display = 'none';
});

btnRecord.addEventListener('click', startRecording);
function applyDefaultSize() {
    if (state.isRecording) return;
    const w = 500, h = 500;
    const left = Math.floor((window.innerWidth - w) / 2);
    const top = Math.floor((window.innerHeight - h) / 2);

    state.selectionRect = { x: left, y: top, w: w, h: h };
    selectionBox.style.width = w + 'px';
    selectionBox.style.height = h + 'px';
    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.display = 'block';
    selectionBox.classList.remove('hidden');
    overlay.style.display = 'none';
    if (instruction) instruction.style.display = 'none';
    updateDimensions(w, h);
}

const btnResetSize = document.getElementById('btn-reset-size');
if (btnResetSize) {
    btnResetSize.addEventListener('click', applyDefaultSize);
}
btnStop.addEventListener('click', (e) => { e.stopPropagation(); stopRecording(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (state.isRecording) stopRecording(); window.api.closeSnipper(); } });

// Toolbar labels are drawn in-page — the native tooltip is invisible behind an
// always-on-top overlay. See ../shared/overlay-tooltip.js.
window.CopyBoardOverlayTooltip.init('.toolbar');
