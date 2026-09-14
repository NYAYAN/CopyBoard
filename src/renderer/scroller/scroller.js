// Scroll capture: pick a region, scroll the app underneath it, get one tall image back.
//
// Three phases live in this one overlay window (see scroller.css for how they are switched):
//
//   select   The frozen screenshot from the main process is the backdrop, dimmed with a hole
//            where the region is — exactly like the snipper.
//   capture  Backdrop and dim are hidden and the window stops taking mouse events, so what
//            the user sees inside the outline is the REAL app and their scrolling reaches it.
//            Frames come from the main process (ScreenCaptureKit), already cropped to the
//            uses) and go to stitcher.js, which reports which rows are new.
//   review   The stitched page, scaled to fit, with copy/save.
//
// The window is excluded from screen capture by the main process (setContentProtection), so
// the outline, the HUD and the toolbar are invisible to our own stream and cannot end up
// baked into the result.

import { createStitcher } from './stitcher.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlay-canvas');
const overlayCtx = overlayCanvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const dimensionsLabel = document.getElementById('dimensions-label');
const toolbar = document.getElementById('toolbar');
const instruction = document.getElementById('instruction');
const hud = document.getElementById('hud');
const hudMain = document.getElementById('hud-main');
const hudStats = document.getElementById('hud-stats');
const hudWarn = document.getElementById('hud-warn');
const hudHint = document.getElementById('hud-hint');
const anchor = document.getElementById('anchor');
const anchorCanvas = document.getElementById('anchor-canvas');
const anchorLabel = document.getElementById('anchor-label');
const preview = document.getElementById('preview');
const previewCanvas = document.getElementById('preview-canvas');
const previewMeta = document.getElementById('preview-meta');
const previewWarn = document.getElementById('preview-warn');

// Örnekleme AKIŞIN hızıyla yürüyor: yeni kare geldiyse örnekle, gelmediyse bekle.
//
// ⚠ Eskiden `setInterval(40)` vardı ve GÖVDESİNDE de `< 40 ms` koruması vardı; ikisi
// çarpışıyordu. Zamanlayıcının doğal sapması ve örneğin kendi maliyeti (7 MB'lık bölgede
// 11 ms) tiklerin yarısını "henüz 40 ms olmamış" diye boşa çeviriyor, hedeflenen 25 Hz
// pratikte 12-16 Hz'e düşüyordu (ölçüldü 2026-09-11: akış 47 kare/sn verirken renderer
// 15-16 örnek/sn alıyordu).
//
// Bu oran doğrudan "ne kadar hızlı kaydırılabilir"i belirliyor: birleştirici kare başına
// ~240 px'e kadar güvenle eşleşiyor, ~320 px'te `ambiguous` reddine düşüyor (üç içerik
// tipinde de ölçüldü: metin, tablo, seyrek). Yani 12 Hz ≈ 2900 px/sn tavan demekti —
// hızlı kaydıran kullanıcıda "Daha yavaş kaydırın" ve 12 sn sonra vazgeçme bu.
const SAMPLE_TICK = 8;
// Emniyet tavanı: 60 Hz üstü örnekleme eşleşmeye bir şey katmıyor, olay döngüsünü aç
// bırakıyor. Aynı kareyi iki kez örneklemek de boşa iş — karar 'idle' çıkıyor, 11 ms gidiyor.
const SAMPLE_MIN_INTERVAL = 16;
// Matching runs on a narrow strip downscaled from the crop rather than the crop itself:
// same rows, so every row index still lines up, but the per-frame getImageData is ~20x
// smaller. Downscaling also box-averages horizontally, which quiets the sampling noise.
const PROFILE_W = 128;
// A region has to be tall enough to leave a usable overlap after a scroll, and wide enough
// for the profile to say anything. Below this the stitcher would refuse every frame.
const MIN_CROP_W = 120;
const MIN_CROP_H = 240;
// Stop once the region has been STILL for this long — reaching the end of the page IS the
// natural end of a scroll capture, so the user should not have to say so twice.
//
// Stillness, not progress: a scroll that outruns the region leaves no overlap, so the
// stitcher refuses those frames and nothing is committed while the user is very much still
// scrolling. Timing that as idleness ended the capture under the user's hands, mid-page.
const IDLE_FINISH_MS = 2500;
const IDLE_HINT_MS = 1000;
// The other side of the same coin: something inside the region keeps changing (an
// animation, a video) so frames never settle AND never match. Stillness will never
// arrive, so the capture still needs a ceiling of its own — with a note saying so,
// because unlike reaching the end of a page this one is a failure the user can act on.
const COMMIT_STALL_MS = 12000;
// Give up when the region has clearly been scrolling for this long and NOTHING has matched.
// Timed from the first motion rather than from Start, so a user who takes a while to find
// their place is not cut off. Without it a capture that can never match has no ending of its
// own: the idle finish is armed only once something has been committed, which would leave
// cancelling as the only way out of a content-less capture.
const STALL_GIVEUP_MS = 8000;
// Accumulated rows are parked in tiles instead of one canvas that has to be reallocated
// every time it fills. 2048 rows keeps the slack in the final part-filled tile small.
const TILE_ROWS = 2048;
const MISS_WARN_STREAK = 3;
// ── Otomatik kaydırma ──────────────────────────────────────────────────────────
// Kaydırmayı KULLANICI değil uygulama yapıyor. Gerekçe: eşleştirici kare başına
// bölgenin ~%42'sinden fazla kaymayı izleyemiyor (ölçüldü) ve bunu kullanıcıdan
// "daha yavaş kaydırın" diye istemek görünmez bir beceri talebiydi — hızlı kaydıran
// herkes cezalandırılıyordu. Tekerleği biz çevirince adım bizim denetimimizde kalıyor
// ve sınır hiç zorlanmıyor.
//
// Kapalı çevrim: bir tekerlek "tık"ının kaç piksel ettiği uygulamaya ve kullanıcının
// fare ayarına göre değişiyor — varsaymıyoruz, ÖLÇÜYORUZ. Birleştirici zaten her
// karede sayfanın kaç piksel kaydığını söylüyor; adım ona göre büyüyüp küçülüyor.
//
// ⚠ Hareket profili SÜREKLİ ve YAVAŞ — ölçümle öğrenildi (2026-09-11). İlk tasarım
// "büyük adım → sayfanın durmasını bekle → ölç" idi; gerçek bir sayfada (OneNote,
// tablo ağırlıklı) 6 birleşimden sonra `ambiguous` retlerine düştü. Sebep: dur-kalk
// hareketi eşleştiriciye en zor girdiyi veriyor — hız her karede değişiyor, hız ipucu
// tutmuyor ve tekrarlayan içerikte aday ofsetler ayrışmıyor. Küçük ve düzenli adımlarda
// ise kareler arası kayma az, örtüşme bol; eşleştiricinin en rahat ettiği durum bu.
//
// HIZ AMAÇ DEĞİL: kullanıcıdan alınan iş zaten kazanç. Tik başına bölgenin ~%8'i
// (≈900 px/sn) ölçülen ret sınırının (%42) çok altında ve güvenli.
const AUTO_TICK_MS = 60;
const AUTO_START_PCT = 0.08;    // tik başına hedef: bölge yüksekliğinin %8'i
const AUTO_MIN_PCT = 0.02;
const AUTO_MAX_PCT = 0.20;
// Ret geldiğinde hız düşürülüyor, temiz birleşimlerde yavaşça toparlanıyor (AIMD).
// Kullanıcıya "yavaşla" demek yerine sistem kendi yavaşlıyor — bütün mesele buydu.
const AUTO_SLOW_FACTOR = 0.6;
const AUTO_SPEED_RECOVER = 1.03;
// Bu kadar arka arkaya ret = ilerleme yok; hız düşürülüyor (bkz. sampleFrame).
const AUTO_SLOW_AFTER_REJECTS = 6;
// Ölçüm penceresi: bir tıkın kaç piksel ettiği bu aralıkta bir güncelleniyor.
const AUTO_MEASURE_MS = 400;
// Hiç kıpırdamazsa: önce ters yön, sonra elle kip. Ölçüt "son hareketten beri" DEĞİL
// "hiç hareket görüldü mü": çalışırken yön çevirmek yakalamayı bozuyor.
const AUTO_FLIP_AFTER_MS = 700;
const AUTO_GIVEUP_MS = 2000;
// Bir tıkın piksel değeri bu aralığın dışına çıkarsa ölçüm bozulmuş demektir
// (animasyon gecikmesi, kullanıcının kendi kaydırması). Sınırlar akıl sağlığı içindir.
const PX_PER_NOTCH_MIN = 8;
const PX_PER_NOTCH_MAX = 400;

// Çapa şeridinde gösterilen satır sayısı (yakalanan görüntünün fiziksel pikselleri).
// Tanınmaya yetecek kadar, ekranı kapatmayacak kadar.
const ANCHOR_ROWS = 120;
// Henüz reddedilmedi ama sınıra yaklaşıldı: bölge yüksekliğinin bu kadarını aşan kare
// başına kaydırma "biraz yavaşlayın" uyarısını açıyor. Birleştirici ~%42'de reddetmeye
// başlıyor (ölçüldü), yani bu eşik kullanıcıya tepki verecek bir pay bırakıyor.
const FAST_HINT_PCT = 0.3;
// Toparlandıktan sonra "devam ediliyor" ne kadar görünsün.
const RECOVERED_MS = 1500;

const state = {
    phase: 'select',
    isSelecting: false, isMoving: false, isResizing: false,
    activeHandle: null, resizeStartRect: null, selectionRect: null,
    startX: 0, startY: 0, dragOffX: 0, dragOffY: 0,
    dpr: window.devicePixelRatio || 1,
    scaleX: null, scaleY: null,
    sourceId: null, captureWidth: null, captureHeight: null,
    lastIgnoreState: null
};

// The decoded backdrop is retained for the lifetime of the overlay: assigning
// canvas.width/height WIPES a canvas, and behind a transparent window a wiped backdrop is
// indistinguishable from the live desktop until the capture comes out wrong.
let screenBitmap = null;

// Live capture state.
let stream = null;
let video = null;
let stitcher = null;
// Ana süreçten gelen en son kare (ImageData). Kare akışı bunu tazeliyor;
// sampleFrame okuyor.
let latestFrame = null;
let crop = null;            // { x, y, w, h } in PHYSICAL pixels of the captured display
let frameA = null, frameB = null;   // ping-pong crop canvases
let curFrame = null, baseFrame = null, lastFrame = null;
let profileCanvas = null, profileCtx = null;
let lastProfile = null;   // en son EŞLEŞTİRİLEN profil (bkz. samePixels)
let headTiles = [];   // prepended rows, each tile filled bottom-up
let tailTiles = [];   // appended rows, each tile filled top-down
let totalRows = 0;
let frameTimer = null;
let idleTimer = null;
let lastSampleAt = 0;
// Akıştan gelen kare sayacı ve en son ÖRNEKLENEN kare — aynı kare iki kez eşleştirilmesin.
let frameSeq = 0;
let sampledSeq = 0;
let lastProgressAt = 0;  // last frame that committed rows
let lastMotionAt = 0;    // last frame where the region was seen to move at all
let missStreak = 0;
let firstMotionAt = 0;   // when the region was first seen to move at all
let finalCanvas = null;
// Rehberlik durumu: son kararın ofseti, kaydırmanın yönü (hangi uca ekleniyor), çapa
// şeridi açık mı, en son ne zaman toparlandı.
let lastOffset = 0;
let lastSide = 'bottom';
// Otomatik kaydırma durumu. 'manual': otomatik denendi ve olmadı (yükseltilmiş pencere,
// macOS'ta Erişilebilirlik izni yok, ya da imleç bölgeye alınamadı) — kullanıcı kendi
// kaydırıyor ve rehberlik/çapa devreye giriyor.
let autoMode = 'off';
let autoTimer = null;
let autoBusy = false;
let autoPct = AUTO_START_PCT;   // tik başına hedef, bölge yüksekliğinin oranı
let autoDir = -1;               // -1 aşağı, +1 yukarı
let pxPerNotch = 0;             // ölçülen: bir tık kaç piksel
let autoSentNotches = 0;        // ölçüm penceresinde gönderilen tık
let autoSeenPx = 0;             // ölçüm penceresinde gözlenen kayma
let autoMeasuredAt = 0;
let autoStartedAt = 0;
let autoEverMoved = false;      // hiç kıpırdadı mı (ölü kip tespiti)
// Taban ilerlediğinden beri gönderilen tık ve ofsetin işareti: ipucunun iki bileşeni.
// İşaret gözlemle öğreniliyor — tekerlek yönü ile ofsetin işareti arasındaki ilişki
// platforma/uygulamaya göre değişebiliyor, varsaymıyoruz.
let autoNotchesSinceBase = 0;
let autoOffsetSign = 0;
let autoRejectStreak = 0;
// Tik başına hedef piksel çoğu zaman BİR TIKTAN küçük (bir tık uygulamaya göre
// 50-300 px). Her tik bir tık göndermek, istenenin kat kat üstünde bir hız demekti —
// ölçümde görüldü: hedef 14 px iken tık 326 px atıyordu ve hız hiç düşmüyordu.
// Bütçe biriktirilip tık ancak dolduğunda gönderiliyor; böylece istenen hız
// tıktan bağımsız olarak tutturuluyor.
let autoBudget = 0;
let anchorShown = false;
let recoveredAt = -Infinity;   // sayfa yeni yüklendiyse `performance.now()` küçük: 0 olsaydı ilk saniyede boş yere "devam ediliyor" derdi

// ── Ölçüm ──────────────────────────────────────────────────────────────────────
// "Çok takılıyor / kaydırma izlenemedi" iki kez bildirildi ve elde yalnız kullanıcının
// tarifi vardı: kare gerçekten kaç fps geliyor, örnekleme mi pahalı, yoksa eşleştirme mi
// reddediyor — hiçbiri bilinmiyordu. Yakalama boyunca saniyede bir satır `console.warn`
// ile copyboard.log'a düşüyor (api-tauri.js konsolu ana sürece yönlendiriyor), böylece
// bir sonraki bildirim kendi teşhisini getiriyor.
const perf = {
    since: 0, recv: 0, bytes: 0, samples: 0, steps: 0,
    putMs: 0, readMs: 0, pushMs: 0,
    commits: 0, rejects: 0, lastOffset: 0, lastStatus: '', lastReason: '',
};
const per = (v, n) => (v / Math.max(1, n)).toFixed(1);
function perfFlush(now) {
    if (!perf.since) { perf.since = now; return; }
    const dt = now - perf.since;
    if (dt < 1000) return;
    const s = perf.samples;
    console.warn(`PERF kaydırma ${crop ? crop.w + 'x' + crop.h : '?'}: `
        + `${per(perf.recv * 1000, dt)} kare/sn (${per(perf.bytes * 1000 / 1048576, dt)} MB/sn), `
        + `${per(perf.samples * 1000, dt)} örnek/sn, `
        + `örnek ${per(perf.putMs + perf.readMs + perf.pushMs, s)} ms `
        + `(kopya ${per(perf.putMs, s)} / okuma ${per(perf.readMs, s)} / eşleştirme ${per(perf.pushMs, s)}), `
        + `${perf.commits} birleşim, ${perf.rejects} ret, son ofset ${perf.lastOffset} `
        + `(${perf.lastStatus}${perf.lastReason ? ' ' + perf.lastReason : ''})`
        + `, oto=${autoMode}${autoMode === 'running'
            ? ` adım=${perf.steps} yön=${autoDir} px/tık=${pxPerNotch.toFixed(1)} hız=%${(autoPct * 100).toFixed(1)}`
            : ''}`);
    perf.steps = 0;
    perf.since = now;
    perf.recv = perf.bytes = perf.samples = 0;
    perf.putMs = perf.readMs = perf.pushMs = 0;
    perf.commits = perf.rejects = 0;
}

// ── Backdrop ───────────────────────────────────────────────────────────────────
function paintScreen() {
    if (!screenBitmap) return false;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(screenBitmap, 0, 0, canvas.width, canvas.height);
    return true;
}

function drawOverlay(x, y, w, h) {
    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.save();
    overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.globalCompositeOperation = 'destination-out';
    overlayCtx.fillStyle = 'rgba(0,0,0,1)';
    overlayCtx.fillRect(x * sx, y * sy, w * sx, h * sy);
    overlayCtx.restore();
    overlayCtx.save();
    overlayCtx.strokeStyle = '#ffffff';
    overlayCtx.globalAlpha = 0.9;
    overlayCtx.lineWidth = Math.max(1, 2 * sx);
    overlayCtx.strokeRect(x * sx, y * sy, w * sx, h * sy);
    overlayCtx.restore();
}

function repaintOverlay() {
    if (state.phase === 'capture') return;
    const r = state.selectionRect;
    if (r) drawOverlay(r.x, r.y, r.w, r.h);
    else drawOverlay(0, 0, window.innerWidth, window.innerHeight);
}

function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    state.dpr = window.devicePixelRatio || 1;

    if (screenBitmap) {
        // A backdrop is loaded: restretch only. Reassigning width/height here would wipe it.
        [canvas, overlayCanvas].forEach(c => {
            c.style.width = w + 'px';
            c.style.height = h + 'px';
        });
        state.scaleX = canvas.width / w;
        state.scaleY = canvas.height / h;
        repaintOverlay();
        return;
    }

    if (state.scaleX == null) state.scaleX = state.dpr;
    if (state.scaleY == null) state.scaleY = state.dpr;
    [canvas, overlayCanvas].forEach(c => {
        c.width = w * state.dpr;
        c.height = h * state.dpr;
        c.style.width = w + 'px';
        c.style.height = h + 'px';
    });
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

if (!window.api) {
    alert('CRITICAL: window.api is UNDEFINED! Preload script failed to load.');
    throw new Error('CopyBoard scroller: preload bridge (window.api) unavailable.');
}

window.api.onCaptureReset(() => { if (state.phase === 'select') resetSelection(); });

window.api.onCaptureScreen((imageData, mode, sourceId, quality, captureWidth, captureHeight) => {
    const logicalW = window.innerWidth;
    const logicalH = window.innerHeight;
    const physW = captureWidth || logicalW;
    const physH = captureHeight || logicalH;

    state.sourceId = sourceId;
    state.captureWidth = physW;
    state.captureHeight = physH;
    state.scaleX = physW / logicalW;
    state.scaleY = physH / logicalH;
    state.dpr = window.devicePixelRatio || 1;

    screenBitmap = null;
    [canvas, overlayCanvas].forEach(c => {
        c.width = physW;
        c.height = physH;
        c.style.width = logicalW + 'px';
        c.style.height = logicalH + 'px';
    });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    resetSelection();

    const finish = () => {
        repaintOverlay();
        document.body.classList.add('ready');
        window.api.notifyReady();
    };

    // An unusable screenshot must never open the overlay: the window is transparent, so an
    // empty backdrop looks exactly like the live desktop and the failure would only surface
    // in the result. Self-heal by asking main to re-capture — we are still hidden here.
    const fail = (reason) => {
        window.api.sendDebugLog('Scroller: capture unusable (' + reason + ') — requesting re-capture');
        window.api.retryCapture();
    };

    if (imageData && imageData.byteLength) {
        createImageBitmap(new Blob([imageData], { type: 'image/png' })).then((bmp) => {
            screenBitmap = bmp;
            paintScreen();
            finish();
        }).catch((err) => fail('çözümlenemedi: ' + ((err && err.message) || 'bilinmeyen hata')));
    } else if (typeof imageData === 'string' && imageData.length > 100) {
        const img = new Image();
        img.onload = () => { screenBitmap = img; paintScreen(); finish(); };
        img.onerror = () => fail('görüntü yüklenemedi');
        img.src = imageData;
    } else {
        fail('boş görüntü verisi');
    }
});

// ── Region selection ───────────────────────────────────────────────────────────
function resetSelection() {
    state.isSelecting = state.isMoving = state.isResizing = false;
    state.selectionRect = null;
    selectionBox.classList.add('hidden');
    toolbar.classList.add('hidden');
    document.body.classList.remove('selecting');
    repaintOverlay();
}

function updateDimensions(w, h) {
    const sx = state.scaleX != null ? state.scaleX : state.dpr;
    const sy = state.scaleY != null ? state.scaleY : state.dpr;
    dimensionsLabel.textContent = `${Math.round(w * sx)} x ${Math.round(h * sy)}`;
}

// Centred under the selection, flipped above it when there is no room below.
function placeToolbar() {
    const r = state.selectionRect;
    if (!r) return;
    toolbar.classList.remove('hidden');
    const tw = toolbar.offsetWidth;
    const th = toolbar.offsetHeight;
    let left = r.x + (r.w - tw) / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - tw - 10));
    let top = r.y + r.h + 16;
    if (top + th > window.innerHeight - 10) top = r.y - th - 16;
    if (top < 10) top = 10;
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
}

function placeHud() {
    const r = state.selectionRect;
    if (!r) return;
    const hw = hud.offsetWidth;
    const hh = hud.offsetHeight;
    let left = r.x + (r.w - hw) / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - hw - 10));
    let top = r.y - hh - 12;
    if (top < 10) top = Math.min(r.y + r.h + 12, window.innerHeight - hh - 10);
    hud.style.left = left + 'px';
    hud.style.top = top + 'px';
}

window.addEventListener('mousedown', (e) => {
    if (state.phase !== 'select') return;
    if (e.target.closest('.toolbar')) return;

    // Overlay üzerinde sürükleme: yeni seçim, seçimi taşıma, köşeden boyutlandırma.
    // Varsayılan davranış üçünde de metin seçimi başlatmak; hızlı sürüklerken WebKit
    // bunu mavi, sönümlenen bir vurguyla boyuyor. CSS'teki `user-select: none` zaten
    // engelliyor ama burada da kesiliyor — `preventDefault()` motordan bağımsız.
    // Araç çubuğu yukarıda elendiği için düğme odaklanması bozulmuyor.
    e.preventDefault();

    if (state.selectionRect) {
        if (e.target.classList.contains('resize-handle')) {
            state.isResizing = true;
            state.activeHandle = e.target.dataset.handle;
            const b = selectionBox.getBoundingClientRect();
            state.resizeStartRect = { left: b.left, top: b.top, width: b.width, height: b.height };
            state.startX = e.clientX; state.startY = e.clientY;
            toolbar.classList.add('hidden');
            document.body.classList.add('selecting');
            return;
        }
        if (e.target === selectionBox) {
            state.isMoving = true;
            const b = selectionBox.getBoundingClientRect();
            state.dragOffX = e.clientX - b.left;
            state.dragOffY = e.clientY - b.top;
            toolbar.classList.add('hidden');
            return;
        }
    }

    window.api.claimCaptureMonitor(); // a new selection clears the other monitors'
    resetSelection();
    state.isSelecting = true;
    document.body.classList.add('selecting');
    state.startX = e.clientX; state.startY = e.clientY;
    selectionBox.style.left = state.startX + 'px';
    selectionBox.style.top = state.startY + 'px';
    selectionBox.style.width = selectionBox.style.height = '0px';
    selectionBox.classList.remove('hidden');
    updateDimensions(0, 0);
});

window.addEventListener('mousemove', (e) => {
    if (state.phase === 'capture') return;
    if (state.phase !== 'select') return;

    if (state.isResizing) {
        const dx = e.clientX - state.startX, dy = e.clientY - state.startY;
        let { left, top, width, height } = state.resizeStartRect;
        if (state.activeHandle.includes('e')) width += dx;
        if (state.activeHandle.includes('s')) height += dy;
        if (state.activeHandle.includes('w')) { left += dx; width -= dx; }
        if (state.activeHandle.includes('n')) { top += dy; height -= dy; }
        if (width < 20) { if (state.activeHandle.includes('w')) left = state.resizeStartRect.left + state.resizeStartRect.width - 20; width = 20; }
        if (height < 20) { if (state.activeHandle.includes('n')) top = state.resizeStartRect.top + state.resizeStartRect.height - 20; height = 20; }
        Object.assign(selectionBox.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
        updateDimensions(width, height);
        drawOverlay(left, top, width, height);
    } else if (state.isMoving) {
        const nx = Math.max(0, Math.min(e.clientX - state.dragOffX, window.innerWidth - selectionBox.offsetWidth));
        const ny = Math.max(0, Math.min(e.clientY - state.dragOffY, window.innerHeight - selectionBox.offsetHeight));
        selectionBox.style.left = nx + 'px';
        selectionBox.style.top = ny + 'px';
        drawOverlay(nx, ny, selectionBox.offsetWidth, selectionBox.offsetHeight);
    } else if (state.isSelecting) {
        const w = Math.abs(e.clientX - state.startX);
        const h = Math.abs(e.clientY - state.startY);
        const x = Math.min(e.clientX, state.startX);
        const y = Math.min(e.clientY, state.startY);
        Object.assign(selectionBox.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        updateDimensions(w, h);
        drawOverlay(x, y, w, h);
    }
});

window.addEventListener('mouseup', () => {
    if (state.phase !== 'select') return;
    if (state.isResizing || state.isMoving || state.isSelecting) {
        const b = selectionBox.getBoundingClientRect();
        if (state.isSelecting && (b.width < 10 || b.height < 10)) { resetSelection(); return; }
        state.selectionRect = { x: b.left, y: b.top, w: b.width, h: b.height };
        placeToolbar();
        showRegionHint();
    }
    state.isResizing = state.isMoving = state.isSelecting = false;
    document.body.classList.remove('selecting');
});

// Warn about a region the stitcher cannot work with BEFORE the user starts scrolling.
function showRegionHint() {
    const c = cropRect();
    if (!c) return;
    if (c.h < MIN_CROP_H || c.w < MIN_CROP_W) {
        instruction.textContent = t('Alan çok küçük — kaydırmalı yakalama için daha büyük bir bölge seçin');
        instruction.classList.add('warn');
    } else {
        instruction.textContent = t('Başlat’a basın, sonra bu alanın üstünde kaydırın');
        instruction.classList.remove('warn');
    }
}

// Selection in PHYSICAL pixels of the captured display, clamped to it.
function cropRect() {
    const r = state.selectionRect;
    if (!r || !state.captureWidth) return null;
    const sx = state.scaleX, sy = state.scaleY;
    const x = Math.max(0, Math.round(r.x * sx));
    const y = Math.max(0, Math.round(r.y * sy));
    const w = Math.max(1, Math.min(Math.round(r.w * sx), state.captureWidth - x));
    const h = Math.max(1, Math.min(Math.round(r.h * sy), state.captureHeight - y));
    return { x, y, w, h };
}

// ── Capture phase ──────────────────────────────────────────────────────────────
function setPhase(next) {
    state.phase = next;
    document.body.classList.remove('phase-select', 'phase-capture', 'phase-review');
    document.body.classList.add('phase-' + next);
    // Click-through is decided in the main process from the areas we report. The report
    // must follow the phase change: finishCapture used to report while still in 'capture',
    // so the review phase kept only the old toolbar rectangle clickable and the Copy/Save
    // buttons under the preview could not be hit (Electron re-enabled the whole window here).
    reportToolbarHitArea();
}

function makeFrameCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cc = c.getContext('2d');
    cc.imageSmoothingEnabled = false;
    return { canvas: c, ctx: cc };
}

async function beginCapture() {
    if (state.phase !== 'select') return;
    crop = cropRect();
    if (!crop || !state.sourceId) return;
    if (crop.w < MIN_CROP_W || crop.h < MIN_CROP_H) { showRegionHint(); return; }

    // Kareler artık ana süreçten geliyor. Electron'da bu bir getUserMedia masaüstü
    // akışıydı; WKWebView'da o yol yok (ne chromeMediaSource ne getDisplayMedia).
    // Rust ScreenCaptureKit'ten okuyup ZATEN KIRPILMIŞ ham RGBA gönderiyor —
    // stitcher.js'e giden veri birebir aynı, yalnız kaynağı değişti.
    try {
        await window.api.scrollBegin(
            { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
            (frame) => {
                latestFrame = frame;
                frameSeq++;
                perf.recv++;
                perf.bytes += frame.data.length;
            }
        );
    } catch (err) {
        console.error('Scroll capture stream failed:', err);
        instruction.textContent = t('Ekran akışı başlatılamadı: ') + ((err && err.message) || err);
        instruction.classList.add('warn');
        stopStream();
        return;
    }

    frameA = makeFrameCanvas(crop.w, crop.h);
    frameB = makeFrameCanvas(crop.w, crop.h);
    curFrame = frameA;
    baseFrame = null;
    lastFrame = null;

    profileCanvas = document.createElement('canvas');
    profileCanvas.width = PROFILE_W;
    profileCanvas.height = crop.h;
    lastProfile = null;
    profileCtx = profileCanvas.getContext('2d', { willReadFrequently: true });
    profileCtx.imageSmoothingEnabled = true; // horizontal box average, not nearest-neighbour

    headTiles = [];
    tailTiles = [];
    totalRows = 0;
    missStreak = 0;
    firstMotionAt = 0;
    finalCanvas = null;
    stitcher = createStitcher({ outputWidth: crop.w });

    setPhase('capture');
    hud.classList.remove('hidden');
    hudWarn.classList.add('hidden');
    updateHud(t('Şimdi kaydırın'));
    placeHud();
    placeToolbar();

    // The main process already closed the other monitors' overlays and armed a global
    // Escape inside `scrollBegin` above (Rust `scroll_begin`). From here the window passes
    // mouse events through so scrolling reaches the app underneath.
    reportToolbarHitArea();

    // Otomatik kaydırma: imleç bir kez bölgeye alınıyor (tekerlek imlecin altındaki
    // pencereye gidiyor). Alınamazsa elle kipe düşüyoruz — köprüsü olmayan bir
    // taşıyıcıda (Electron) da aynı yol.
    autoDir = -1;
    pxPerNotch = 0;
    autoPct = AUTO_START_PCT;
    autoSentNotches = 0;
    autoSeenPx = 0;
    autoBudget = 0;
    autoEverMoved = false;
    autoNotchesSinceBase = 0;
    autoOffsetSign = 0;
    autoRejectStreak = 0;
    autoBusy = false;
    autoMeasuredAt = autoStartedAt = performance.now();
    if (window.api.autoScrollBegin) {
        autoMode = (await window.api.autoScrollBegin(crop)) ? 'running' : 'manual';
    } else {
        autoMode = 'manual';
    }
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(autoTick, AUTO_TICK_MS);
    hudHint.textContent = autoMode === 'running'
        ? t('Sayfa bitince durur · Esc ile durdurun')
        : t('Kaydırmayı bırakınca biter');

    lastSampleAt = 0;
    frameSeq = sampledSeq = 0;
    lastOffset = 0;
    lastSide = 'bottom';
    recoveredAt = -Infinity;
    hideAnchor();
    lastProgressAt = lastMotionAt = performance.now();
    startFrameLoop();
}

function startFrameLoop() {
    // A desktop stream only produces frames when the screen CHANGES, so once the user stops
    // scrolling on a still page the frame callback stops firing entirely. The finish check
    // cannot live in there or the capture would hang at the end of every page it completes.
    idleTimer = setInterval(() => {
        if (state.phase !== 'capture') return;
        const now = performance.now();
        perfFlush(now);
        refreshHud(now);
        if (stitcher.started) {
            checkAutoFinish(now);
        } else if (firstMotionAt && now - firstMotionAt > STALL_GIVEUP_MS) {
            finishCapture(null); // routes to the "nothing was captured" path
        }
    }, 250);

    // Kareler ana süreçten geliyor; `latestFrame` her varışta tazeleniyor ve `frameSeq`
    // artıyor. Döngü yalnızca YENİ kare varsa örnekliyor (bkz. SAMPLE_TICK), yani örnekleme
    // oranı akışın oranına eşit: ne boşa eşleştirme, ne atlanan kare. Kullanıcı kaydırmayı
    // bıraktığında yeni kare gelmiyor, örnekleme de kendiliğinden duruyor — bitişi o yüzden
    // yukarıdaki 250 ms'lik zamanlayıcı görüyor (lastMotionAt ilerlemiyor).
    frameTimer = setInterval(() => {
        if (state.phase !== 'capture') return;
        if (sampledSeq === frameSeq) return;                    // yeni kare yok
        const now = performance.now();
        if (now - lastSampleAt < SAMPLE_MIN_INTERVAL) return;   // emniyet tavanı
        sampledSeq = frameSeq;
        lastSampleAt = now;
        sampleFrame(now);
    }, SAMPLE_TICK);
}

function stopFrameLoop() {
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

function stopStream() {
    stopAuto();
    stopFrameLoop();
    latestFrame = null;
    try { window.api.scrollEnd(); } catch (e) { /* ana süreç zaten kapanmış olabilir */ }
}

// Copy `height` rows starting at `srcTop` from a crop canvas onto one end of the strip.
//
// Two chains, because a capture grows from whichever end the user scrolls towards. `tailTiles`
// fill downward and are composed in order; `headTiles` fill UPWARD from the bottom of each
// tile and are composed in reverse, which is what lets rows be prepended without moving any
// pixels that are already placed.
function addRows(srcCanvas, srcTop, height, side) {
    const head = side === 'top';
    const chain = head ? headTiles : tailTiles;
    let remaining = height;

    while (remaining > 0) {
        let tile = chain[chain.length - 1];
        if (!tile || tile.rows >= TILE_ROWS) {
            tile = { ...makeFrameCanvas(crop.w, TILE_ROWS), rows: 0 };
            chain.push(tile);
        }
        const n = Math.min(remaining, TILE_ROWS - tile.rows);
        if (head) {
            // Take rows from the BOTTOM of what is left to place, so the tile fills upward
            // and the strip stays in page order.
            tile.ctx.drawImage(srcCanvas, 0, srcTop + remaining - n, crop.w, n,
                0, TILE_ROWS - tile.rows - n, crop.w, n);
        } else {
            tile.ctx.drawImage(srcCanvas, 0, srcTop + (height - remaining), crop.w, n,
                0, tile.rows, crop.w, n);
        }
        tile.rows += n;
        remaining -= n;
        totalRows += n;
    }
}

/// İki profil aynı mı? (Boyutları eşit: bölge yakalama boyunca sabit.)
function samePixels(a, b) {
    if (!a || !b || a.data.length !== b.data.length) return false;
    const x = a.data, y = b.data;
    // Alfa hep 255, R/G/B gri profilde eşit: kanal başına bir bayt karşılaştırmak yeter.
    for (let i = 0; i < x.length; i += 4) {
        if (x[i] !== y[i]) return false;
    }
    return true;
}

function sampleFrame(now) {
    // Kare ana süreçte ZATEN kırpıldı (SCStream sourceRect), yani burada ölçek/kırpma
    // hesabı yok — gelen veri doğrudan kare tuvaline basılıyor.
    if (!latestFrame) return;

    const drawn = curFrame;
    const t0 = performance.now();
    drawn.ctx.putImageData(latestFrame, 0, 0);

    const t1 = performance.now();
    profileCtx.drawImage(drawn.canvas, 0, 0, crop.w, crop.h, 0, 0, PROFILE_W, crop.h);
    const profile = profileCtx.getImageData(0, 0, PROFILE_W, crop.h);
    const t2 = performance.now();
    // Otomatik kaydırmada beklenen ofset: taban ilerlediğinden beri gönderilen tık ×
    // ölçülen px/tık, işareti gözlemle öğrenilmiş yön. Belirsiz karelerde bu, tahmin
    // değil doğrulama (bkz. stitcher.push).
    const hint = (autoMode === 'running' && pxPerNotch > 0 && autoOffsetSign !== 0)
        ? autoNotchesSinceBase * pxPerNotch * autoOffsetSign
        : 0;

    // ⚠ Kare bir öncekiyle AYNIYSA eşleştirmeye hiç girilmiyor.
    //
    // Ölçümle bulundu (2026-09-11): ekran durduğunda ve taban tutulmuş bir ret
    // durumundayken her yeni kare AYNI belirsiz kararı üretiyordu — saniyede 24 ret,
    // hep aynı ofset. O retler `lastMotionAt`i tazelediği için "sayfa bitti" tespiti
    // hiç çalışmıyor, yakalama 12 sn boşuna bekleyip vazgeçiyordu. Ekran değişmiyorsa
    // söylenecek yeni bir şey yok: hareket, eşleştiricinin KARARINDAN değil karenin
    // gerçekten değişmesinden okunmalı. Yan kazanç: duran ekranda eşleştirme bedava.
    if (samePixels(profile, lastProfile)) {
        perf.samples++;
        perf.putMs += t1 - t0;
        perf.readMs += t2 - t1;
        refreshHud(now);
        checkAutoFinish(now);
        return;
    }
    lastProfile = profile;

    const decision = stitcher.push(profile, { hint });
    const t3 = performance.now();
    perf.samples++;
    perf.putMs += t1 - t0;
    perf.readMs += t2 - t1;
    perf.pushMs += t3 - t2;
    perf.lastOffset = decision.offset;
    perf.lastStatus = decision.status;
    perf.lastReason = decision.reason || '';
    if (decision.base || decision.add) perf.commits++;
    if (decision.status === 'reject') perf.rejects++;

    lastOffset = decision.offset;
    if (decision.add) lastSide = decision.add.side;
    // Otomatik kaydırmanın kapalı çevrimi: gözlenen kayma hem "bir tık kaç piksel"
    // ölçümünü hem de hız uyarlamasını besliyor.
    // ⚠ Yalnız TABAN İLERLEDİĞİNDE sayılıyor. Tutulan bir tabana karşı ölçülen ofset
    // her karede aynı değeri veriyor; onu toplamak "bir tık kaç piksel" ölçümünü
    // şişiriyordu (240 → 390 px, ölçüldü) ve hız denetimini bozuyordu.
    const moved = (decision.base || decision.add) ? Math.abs(decision.offset || 0) : 0;
    if (moved > 0) {
        autoSeenPx += moved;
        autoEverMoved = true;
    }
    if (autoMode === 'running') {
        // Hız denetiminin ölçütü İLERLEME — reddedilen karenin bildirdiği ofset DEĞİL.
        //
        // Ölçüldü (2026-09-11): eşleştirici bir kareyi reddettiğinde bildirdiği ofset
        // zaten güvenilmez (tekrarlayan içerikte 183 px'lik gerçek kayma −8 px diye
        // raporlanıyordu). O sayıya bakan bir kural "hız suçlu değil" diye karar verip
        // hiç yavaşlamıyor ve yakalama tamamen duruyordu. Tek sağlam sinyal şu: son
        // karelerde bir şey biriktirebildik mi?
        if (decision.base || decision.add) {
            autoRejectStreak = 0;
            autoPct = Math.min(AUTO_MAX_PCT, autoPct * AUTO_SPEED_RECOVER);
        } else if (decision.status === 'reject') {
            autoRejectStreak++;
            // Üst üste ret: ne olduğunu bilmiyoruz ama elimizdeki tek kol yavaşlamak.
            // Tabana (%2) kadar inebiliyor; ölçümde o hızda aynı içerik saniyede
            // 11-20 birleşim veriyordu.
            if (autoRejectStreak >= AUTO_SLOW_AFTER_REJECTS) {
                autoRejectStreak = 0;
                autoPct = Math.max(AUTO_MIN_PCT, autoPct * AUTO_SLOW_FACTOR);
            }
        }
    }

    if (decision.base) addRows(baseFrame.canvas, decision.base.top, decision.base.height, 'bottom');
    if (decision.add) addRows(drawn.canvas, decision.add.top, decision.add.height, decision.add.side);

    lastFrame = drawn;
    // Whenever the stitcher advanced its base profile, the matching canvas has to advance
    // too — including on 'seen', where the frame matched but held no new rows.
    const advanced = decision.status === 'need-more' || decision.status === 'seen'
        || decision.base || decision.add;
    if (advanced) {
        baseFrame = drawn;
        curFrame = drawn === frameA ? frameB : frameA;
        autoNotchesSinceBase = 0;
    }
    // Yönün ofset işaretine karşılığı: ilk gerçek birleşimlerden öğreniliyor.
    if (autoMode === 'running' && decision.add && Math.abs(decision.offset) > 2) {
        autoOffsetSign = Math.sign(decision.offset);
    }
    if (decision.offset !== 0 || decision.status === 'reject') {
        if (!firstMotionAt) firstMotionAt = now;
    }
    // 'idle' is the stitcher's own verdict that the region barely moved. Everything else —
    // a refused frame included — means the picture under the pointer is still changing, so
    // the user has not finished with it.
    if (decision.status !== 'idle' && decision.status !== 'need-more') lastMotionAt = now;
    if (decision.base || decision.add) {
        lastProgressAt = now;
        // Kayıptan döndü: kullanıcı geri kaydırıp şeridi buldu, bunu söyle.
        if (anchorShown) recoveredAt = now;
        missStreak = 0;
    } else if (decision.status === 'reject') {
        missStreak++;
    }

    if (decision.status === 'full') {
        finishCapture(t('Boyut sınırına ulaşıldı'));
        return;
    }

    refreshHud(now);
    checkAutoFinish(now);
}

// Asked from both loops, so they cannot drift apart: a still page stops producing frames
// altogether, so only the timer can see the end of a scroll — and only the frame path sees
// a scroll that is still going.
function checkAutoFinish(now) {
    if (!stitcher.started) return;
    // The end of the page is the end of the capture: nothing has moved for a while, so
    // there is nothing left to scroll to, and making the user confirm that would add a
    // step to every single capture.
    if (now - lastMotionAt > IDLE_FINISH_MS) {
        finishCapture(null);
    } else if (now - lastProgressAt > COMMIT_STALL_MS) {
        // Still moving, but nothing has landed for a long time. Ending silently here would
        // read as the same bug this clock was split to fix, so it says why.
        finishCapture(t('Hızlı kaydırma yüzünden son kısım eklenemedi'));
    }
}

function updateHud(main) {
    hudMain.textContent = main;
    const rows = totalRows;
    hudStats.textContent = rows
        ? t('{h} px · {n} birleşim', { h: rows, n: stitcher.commits })
        : '';
}

function refreshHud(now) {
    if (autoMode === 'running' && !stitcher.started) {
        updateHud(t('Otomatik kaydırılıyor'));
    } else if (!stitcher.started) {
        updateHud(t('Şimdi kaydırın'));
    } else if (autoMode === 'running' && now - lastMotionAt <= IDLE_HINT_MS) {
        updateHud(t('Otomatik kaydırılıyor'));
    } else if (now - lastMotionAt > IDLE_HINT_MS) {
        // Follows the same clock as the finish: announcing "finishing" while the user is
        // mid-scroll was the visible half of the bug that ended those captures.
        updateHud(t('Bitiriliyor…'));
    } else {
        updateHud(t('Yakalanıyor'));
    }

    const g = guidance(now);
    hudWarn.classList.remove('fast', 'lost', 'ok');
    if (g) {
        hudWarn.textContent = g.text;
        hudWarn.classList.add(g.cls);
        hudWarn.classList.remove('hidden');
    } else {
        hudWarn.classList.add('hidden');
    }
    placeHud();
}

/// Sürekli kaydırma döngüsünün bir tiki: küçük bir adım at, arada bir ölç.
async function autoTick() {
    if (state.phase !== 'capture' || autoMode !== 'running' || autoBusy) return;
    const now = performance.now();

    // Bir tık kaç piksel? Uygulamaya ve kullanıcının fare ayarına göre değişiyor,
    // o yüzden varsayılmıyor: gönderilen tık ile gözlenen kayma oranlanıyor.
    if (now - autoMeasuredAt > AUTO_MEASURE_MS) {
        if (autoSentNotches > 0 && autoSeenPx > 0) {
            const measured = Math.max(PX_PER_NOTCH_MIN,
                Math.min(PX_PER_NOTCH_MAX, autoSeenPx / autoSentNotches));
            pxPerNotch = pxPerNotch ? pxPerNotch * 0.7 + measured * 0.3 : measured;
        }
        autoSentNotches = 0;
        autoSeenPx = 0;
        autoMeasuredAt = now;
    }

    // Hiç kıpırdamadı mı? Önce ters yönü dene (sayfa o yönün sonunda olabilir, ya da
    // tekerlek işareti bu platformda ters), sonra elle kipe düş. Bir kez kıpırdadıysa
    // bir daha buraya girilmiyor: çalışan bir yakalamanın yönünü çevirmek onu bozar.
    if (!autoEverMoved) {
        const still = now - autoStartedAt;
        if (still > AUTO_GIVEUP_MS) {
            autoMode = 'manual';
            return;
        }
        if (still > AUTO_FLIP_AFTER_MS && autoDir === -1) {
            autoDir = 1;
        }
    }

    // Tik başına hedef piksel bütçeye ekleniyor; tık ancak bütçe dolunca gidiyor.
    autoBudget += crop.h * autoPct;
    const px = pxPerNotch > 0 ? pxPerNotch : 40;
    const notches = Math.min(20, Math.floor(autoBudget / px));
    if (notches < 1) return;
    autoBudget -= notches * px;

    autoBusy = true;
    try {
        // `false`: imleç bölgenin dışında — kullanıcı fareyi araç çubuğuna ya da başka
        // bir pencereye götürmüş. Tekerleği oraya göndermiyoruz, bir sonraki tikte bakarız.
        if (await window.api.autoScrollStep(crop, notches * autoDir)) {
            perf.steps++;
            autoSentNotches += notches;
            autoNotchesSinceBase += notches;
        } else {
            autoBudget += notches * px;   // gitmedi: bütçeyi geri ver
        }
    } finally {
        autoBusy = false;
    }
}

function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (autoMode !== 'off') {
        try { window.api.autoScrollEnd(); } catch (e) { /* ana süreç kapanmış olabilir */ }
    }
    autoMode = 'off';
}

// ── Kayıp kaydırma rehberliği ──────────────────────────────────────────────────
//
// Kare başına kaydırma bölgenin yarısını aşınca birleştirici eşleşmeyi reddediyor ve
// TABANI TUTUYOR — yani kullanıcı en son yakalanan yere geri döndüğünde yakalama
// kaldığı yerden sürüyor. Eski arayüz bunu yalnız "Daha yavaş kaydırın" diye
// söylüyordu: kullanıcı ne olduğunu (son kısım eklenmedi), ne yapacağını (geri dön) ve
// nereye kadar (buraya) bilmiyordu. Şerit üçünü birden yanıtlıyor.

/// En son yakalanan `rows` satırı veren kaynak: kaydırma yönüne göre kuyruk ya da baş
/// zincirinin SON karosu (baş karoları alttan yukarı doluyor, bkz. addRows).
function lastCapturedStrip(rows) {
    if (lastSide === 'top') {
        const tile = headTiles[headTiles.length - 1];
        if (!tile || !tile.rows) return null;
        return { canvas: tile.canvas, sy: TILE_ROWS - tile.rows, sh: Math.min(rows, tile.rows) };
    }
    const tile = tailTiles[tailTiles.length - 1];
    if (!tile || !tile.rows) return null;
    const sh = Math.min(rows, tile.rows);
    return { canvas: tile.canvas, sy: tile.rows - sh, sh };
}

function showAnchor(now) {
    if (anchorShown) return;
    const strip = lastCapturedStrip(ANCHOR_ROWS);
    const r = state.selectionRect;
    if (!strip || !r || !crop) return;

    anchorCanvas.width = crop.w;
    anchorCanvas.height = strip.sh;
    const actx = anchorCanvas.getContext('2d');
    actx.imageSmoothingEnabled = false;
    actx.drawImage(strip.canvas, 0, strip.sy, crop.w, strip.sh, 0, 0, crop.w, strip.sh);

    const sy = state.scaleY || state.dpr || 1;
    const cssH = Math.round(strip.sh / sy);
    anchorCanvas.style.width = r.w + 'px';
    anchorCanvas.style.height = cssH + 'px';
    anchor.style.left = r.x + 'px';
    anchor.style.width = r.w + 'px';

    // Aşağı kaydırılıyorduysa kayıp içerik YUKARIDA kaldı: şerit bölgenin üstüne.
    const above = lastSide !== 'top';
    const gap = 10;
    if (above && r.y >= cssH + gap) anchor.style.top = (r.y - cssH - gap) + 'px';
    else if (!above && r.y + r.h + cssH + gap <= window.innerHeight) anchor.style.top = (r.y + r.h + gap) + 'px';
    else anchor.style.top = (above ? r.y : r.y + r.h - cssH) + 'px';  // sığmadı: içeride

    anchorLabel.textContent = t('en son yakalanan');
    anchor.classList.remove('hidden');
    anchorShown = true;
    // Vazgeçme sayacı rehberlik BAŞLADIĞI andan işlesin: kullanıcı yeni yeni ne
    // yapacağını öğrenirken 12 sn'lik pencerenin ortasında olmasın.
    lastProgressAt = now;
}

function hideAnchor() {
    if (!anchorShown) return;
    anchor.classList.add('hidden');
    anchorShown = false;
}

/// HUD'un ikinci satırı: sessiz (iyi gidiyor) → sarı (sınıra yaklaştı) → kırmızı (kayıp)
/// → yeşil (toparlandı).
function guidance(now) {
    // Otomatik kaydırma yürürken hız uyarısının anlamı yok: adımı zaten biz atıyoruz.
    if (autoMode === 'running') { hideAnchor(); return null; }
    if (autoMode === 'manual' && !stitcher.started) {
        return { cls: 'fast', text: t('Otomatik kaydırılamadı — kendiniz kaydırın') };
    }
    if (missStreak >= MISS_WARN_STREAK) {
        if (totalRows > 0) {
            showAnchor(now);
            if (anchorShown) {
                return { cls: 'lost', text: t('Çok hızlı — bu görüntüyü görene dek geri kaydırın') };
            }
        }
        return { cls: 'lost', text: t('Kaydırma izlenemedi — daha küçük adımlarla kaydırın') };
    }
    hideAnchor();
    if (now - recoveredAt < RECOVERED_MS) return { cls: 'ok', text: t('Kaldığı yerden devam ediliyor') };
    if (crop && Math.abs(lastOffset) > crop.h * FAST_HINT_PCT) {
        return { cls: 'fast', text: t('Biraz yavaşlayın') };
    }
    return null;
}

// ── Finish & review ────────────────────────────────────────────────────────────
function releaseTiles() {
    [...headTiles, ...tailTiles].forEach(tile => { tile.canvas.width = tile.canvas.height = 0; });
    headTiles = [];
    tailTiles = [];
}

// Head chain in reverse (each of those tiles is filled from its bottom), then the tail chain
// in order, with the sticky header and footer laid over the two ends.
function composeFinal(header, footer) {
    const out = document.createElement('canvas');
    out.width = crop.w;
    out.height = totalRows + header + footer;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;

    let y = header;
    for (let i = headTiles.length - 1; i >= 0; i--) {
        const tile = headTiles[i];
        octx.drawImage(tile.canvas, 0, TILE_ROWS - tile.rows, crop.w, tile.rows, 0, y, crop.w, tile.rows);
        y += tile.rows;
    }
    for (const tile of tailTiles) {
        octx.drawImage(tile.canvas, 0, 0, crop.w, tile.rows, 0, y, crop.w, tile.rows);
        y += tile.rows;
    }

    // Sticky chrome, once, at the ends. Any frame is a valid source — chrome is by definition
    // the part that never changed — so the last one is used for both.
    if (lastFrame) {
        if (header > 0) octx.drawImage(lastFrame.canvas, 0, 0, crop.w, header, 0, 0, crop.w, header);
        if (footer > 0) {
            octx.drawImage(lastFrame.canvas, 0, crop.h - footer, crop.w, footer,
                0, out.height - footer, crop.w, footer);
        }
    }

    // Release the tiles as soon as they are composed — at this moment two full copies of a
    // long page are in memory, which is the peak of the whole feature.
    releaseTiles();
    return out;
}

function finishCapture(note) {
    if (state.phase !== 'capture') return;

    const captured = totalRows;
    const gaps = stitcher.gaps;
    // Sticky chrome is not part of the strip: it would be stranded mid-image the moment
    // anything was prepended above it. composeFinal lays it over the two ends instead.
    const header = stitcher.started && lastFrame ? stitcher.headerHeight : 0;
    const footer = stitcher.started && lastFrame ? stitcher.footerHeight : 0;

    console.warn(`PERF kaydırma bitti: ${captured} satır, ${stitcher.commits} birleşim, `
        + `${gaps} boşluk, bölge ${crop ? crop.w + 'x' + crop.h : '?'}`
        + (note ? ` — ${note}` : ''));

    stopStream();
    window.api.scrollEnd();
    reportToolbarHitArea();
    hud.classList.add('hidden');
    hideAnchor();

    if (!captured) {
        // Nothing was ever matched — most likely the user never scrolled, or the content
        // moves in a way the stitcher cannot follow. Back to selection rather than a dead end.
        releaseTiles();
        setPhase('select');
        paintScreen();
        repaintOverlay();
        placeToolbar();
        instruction.classList.remove('hidden');
        instruction.textContent = missStreak > 0
            ? t('Hiçbir şey yakalanamadı — çok hızlı kaydırıldı, daha küçük adımlarla deneyin')
            : t('Hiçbir şey yakalanamadı — Başlat’a bastıktan sonra alanın üstünde kaydırın');
        instruction.classList.add('warn');
        return;
    }

    finalCanvas = composeFinal(header, footer);
    setPhase('review');
    repaintOverlay();          // full dim behind the preview
    showPreview(note, gaps);
}

function showPreview(note, gaps) {
    const maxW = Math.min(window.innerWidth * 0.5, 520);
    const maxH = window.innerHeight * 0.6;
    const scale = Math.min(maxW / finalCanvas.width, maxH / finalCanvas.height, 1);
    previewCanvas.width = Math.max(1, Math.round(finalCanvas.width * scale));
    previewCanvas.height = Math.max(1, Math.round(finalCanvas.height * scale));
    const pctx = previewCanvas.getContext('2d');
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(finalCanvas, 0, 0, previewCanvas.width, previewCanvas.height);

    previewMeta.textContent = `${finalCanvas.width} × ${finalCanvas.height} px`;

    const warnings = [];
    if (note) warnings.push(note);
    if (gaps > 0) warnings.push(t('{n} kare eşleşmedi — içerik eksik olabilir', { n: gaps }));
    if (warnings.length) {
        previewWarn.textContent = warnings.join(' · ');
        previewWarn.classList.remove('hidden');
    } else {
        previewWarn.classList.add('hidden');
    }

    preview.classList.remove('hidden');
    instruction.classList.add('hidden');
    // Centre the toolbar under the preview panel now that it has a size.
    const pr = preview.getBoundingClientRect();
    toolbar.classList.remove('hidden');
    toolbar.style.left = Math.max(10, pr.left + (pr.width - toolbar.offsetWidth) / 2) + 'px';
    toolbar.style.top = Math.min(pr.bottom + 12, window.innerHeight - toolbar.offsetHeight - 10) + 'px';
}

// Export is not instant — a stitched page is tens of megapixels and the PNG encode alone
// runs for seconds. Saying so on the button matters more here than anywhere else in the
// app: with nothing changing, the click looked like it had missed, so it got pressed
// again, and EVERY press ran another encode and asked for another save dialog. Those
// dialogs then arrived one after another, minutes later, on top of whatever the user had
// moved on to — one of them turned up right after a copy had already finished.
let exporting = false;
let exportHold = null;
const copyBtn = document.getElementById('btn-copy');
const saveBtn = document.getElementById('btn-save');

function setExporting(btn) {
    exporting = true;
    [copyBtn, saveBtn].forEach(b => { if (b) b.disabled = true; });
    if (btn) btn.classList.add('busy'); // spinner in place of the icon; the label stays put
}

function clearExporting() {
    if (exportHold) { clearTimeout(exportHold); exportHold = null; }
    exporting = false;
    [copyBtn, saveBtn].forEach(b => {
        if (!b) return;
        b.disabled = false;
        b.classList.remove('busy');
    });
}

// PNG as bytes, not a data URL: a stitched page runs to tens of megabytes and base64 would
// add a third on top of a full string copy at each end of the IPC hop.
// holdForDialog: stay busy past the handoff, until the main process reports that the save
// panel is on screen. The encode is only half the wait — the buffer still has to cross the
// IPC and the panel still has to come up — and a button that returns to "Kaydet" during
// that gap is the button that looked like it had done nothing.
function exportPng(btn, send, holdForDialog) {
    if (!finalCanvas || exporting) return;
    setExporting(btn);
    finalCanvas.toBlob((blob) => {
        if (!blob) { clearExporting(); alert(t('Görüntü oluşturulamadı.')); return; }
        blob.arrayBuffer()
            .then((ab) => {
                send(ab);
                if (!holdForDialog) return clearExporting();
                // Never stuck: if that report never comes, the buttons come back anyway.
                exportHold = setTimeout(clearExporting, 15000);
            })
            .catch((err) => { clearExporting(); alert(t('Görüntü aktarılamadı: ') + err.message); });
    }, 'image/png');
}

// The panel is a sheet on this window, so it blocks the toolbar while it is up; releasing
// the buttons here is what puts them back for a CANCELLED save, where this overlay stays.
if (window.api.onSaveDialogOpen) window.api.onSaveDialogOpen(clearExporting);

// ── Kaydırma sırasında tıklama geçirgenliği ────────────────────────────────────
// Pencere fareyi yok sayıyor ki kaydırma alttaki uygulamaya ulaşsın; araç çubuğu ise
// tıklanabilir kalmalı. Electron bunu `setIgnoreMouseEvents(true, { forward: true })`
// ile yapıyordu — geçirgen ama mousemove alan pencere. Tauri'de `forward` yok ve
// macOS'ta geçirgen pencere hiç mousemove almıyor, yani araç çubuğuna geri dönmek
// imkânsız olurdu (BULGU F5-d). Artık yalnız araç çubuğunun dikdörtgeni bildiriliyor;
// imleci ana süreç yokluyor.
const TOOLBAR_HIT_PADDING = 10;

function reportToolbarHitArea() {
    if (state.phase !== 'capture') {
        // Seçim ve inceleme evrelerinde overlay tamamen etkileşimli.
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

// Araç çubuğu evre değişimlerinde yer değiştiriyor.
window.addEventListener('resize', reportToolbarHitArea);

// ── Buttons & keys ─────────────────────────────────────────────────────────────
function cancelAll() {
    if (state.phase === 'capture') {
        stopStream();
        window.api.scrollEnd();
        reportToolbarHitArea();
    }
    window.api.closeSnipper();
}

const actions = {
    'btn-start': () => beginCapture(),
    'btn-finish': () => finishCapture(null),
    'btn-copy': () => exportPng(copyBtn, (ab) => window.api.sendCopyBuffer(ab), false),
    'btn-save': () => exportPng(saveBtn, (ab) => window.api.sendSaveBuffer(ab), true),
    'btn-close': () => cancelAll()
};

Object.entries(actions).forEach(([id, action]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        try { action(); } catch (err) { alert('Error: ' + err.message); }
    });
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { cancelAll(); return; }
    const cmdOrCtrl = e.ctrlKey || e.metaKey;
    if (state.phase === 'select' && e.key === 'Enter' && state.selectionRect) {
        e.preventDefault();
        beginCapture();
    } else if (state.phase === 'capture' && e.key === 'Enter') {
        e.preventDefault();
        finishCapture(null);
    } else if (state.phase === 'review') {
        if (e.key === 'Enter' || (cmdOrCtrl && e.key.toLowerCase() === 'c')) {
            e.preventDefault();
            actions['btn-copy']();
        } else if (cmdOrCtrl && e.key.toLowerCase() === 's') {
            e.preventDefault();
            actions['btn-save']();
        }
    }
});

window.addEventListener('beforeunload', () => stopStream());

// Toolbar labels are drawn in-page — a native tooltip is invisible behind an always-on-top
// overlay. See ../shared/overlay-tooltip.js.
//
// Queued on DOMContentLoaded rather than called outright, unlike the snipper's classic
// script: a module runs BEFORE that event, so init() would read the title attributes while
// they are still the Turkish source and freeze them into an English UI. i18n.js registered
// its own listener while the document was parsing, so ours is guaranteed to run after it.
if (document.readyState === 'complete') {
    window.CopyBoardOverlayTooltip.init('.toolbar');
} else {
    document.addEventListener('DOMContentLoaded', () => window.CopyBoardOverlayTooltip.init('.toolbar'));
}
