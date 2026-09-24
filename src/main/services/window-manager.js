const { BrowserWindow, screen, app, dialog, globalShortcut, desktopCapturer } = require('electron');
const { t } = require('./i18n');
const path = require('path');
const { state, store } = require('./state');
const { warmPasteHelper } = require('./paste-service');

// A window shown from the tray can get a 'blur' microseconds later, while macOS is still
// handing focus back to the app that was active before the click — the blur handler would
// hide it again and t("Göster") looked like it did nothing. Blurs this soon after a
// deliberate show are ignored.
const SHOW_SETTLE_MS = 600;

function showMain() {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const { width, height } = display.workAreaSize;
        state.mainWindow.setAlwaysOnTop(true, 'screen-saver');
        state.mainWindow.setPosition(
            display.workArea.x + width - 380,
            display.workArea.y + height - 560
        );
        state.mainWindowShownAt = Date.now();
        state.mainWindowWasFocused = false;
        state.mainWindow.show();
        // The dock is hidden (accessory app), so show()+focus() alone doesn't necessarily
        // make CopyBoard the active app and the fresh window can lose focus at once.
        if (process.platform === 'darwin') {
            try { app.focus({ steal: true }); } catch (e) { console.error('app.focus failed:', e); }
        }
        state.mainWindow.focus();
        // History pushes skip hidden windows (see history-manager broadcast), so the list
        // may be stale from before the window was hidden — refresh it now that it's visible.
        state.mainWindow.webContents.send('update-history', {
            history: state.history,
            favorites: state.favorites
        });
    }
}

function createMainWindow() {
    state.mainWindow = new BrowserWindow({
        width: 350, height: 550, frame: false, show: false, skipTaskbar: true,
        transparent: process.platform === 'darwin',
        vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
        visualEffectState: 'active',
        backgroundColor: '#2c2c2e',
        fullscreenable: false,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    // macOS Spaces: without this the window belongs to the Space it was last shown on,
    // so the global shortcut yanks the user over to that desktop instead of opening the
    // popup on the current one. Joining all workspaces (like the widget and quick-paste
    // windows) makes it appear wherever the user is.
    state.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) require('electron').shell.openExternal(url);
        return { action: 'deny' };
    });

    state.mainWindow.loadFile(path.join(__dirname, '../../renderer/main-window/index.html'));
    state.mainWindow.on('focus', () => { state.mainWindowWasFocused = true; });
    state.mainWindow.on('blur', () => {
        if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
        if (Date.now() - (state.mainWindowShownAt || 0) < SHOW_SETTLE_MS) return; // focus still settling
        // Close-on-click-away only makes sense for a window that actually HELD focus. If it
        // never got it (another app kept/stole it after the tray click), a blur here means
        // the window never became active — hiding on it is what made t("Göster") look dead.
        if (!state.mainWindowWasFocused) return;
        state.mainWindowHiddenAt = Date.now();
        state.mainWindow.webContents.send('reset-view');
        state.mainWindow.hide();
    });
}

// Tray click = open/close. The window hides itself on blur, so by the time the click
// event arrives it has usually ALREADY been hidden by that very click — re-showing it
// then would make the tray icon unusable as a close button. A hide that just happened is
// therefore treated as "this click closed it".
function toggleMain() {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) {
        state.mainWindowHiddenAt = Date.now();
        win.hide();
        return;
    }
    if (Date.now() - (state.mainWindowHiddenAt || 0) < 400) return;
    showMain();
}

function createCapture(type = 'draw', display = null) {
    if (!display) display = screen.getPrimaryDisplay();
    // Fullscreen on the target display (x/y select the monitor). Fullscreen hides the OS
    // taskbar so it isn't shown twice (real taskbar + the taskbar baked into the captured
    // screenshot). This is per-monitor: the original single-window code already opened a
    // fullscreen overlay on whichever monitor the cursor was on, secondary monitors included.
    const win = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y,
        width: display.bounds.width, height: display.bounds.height,
        frame: false, transparent: true, alwaysOnTop: true,
        fullscreen: process.platform !== 'darwin',
        simpleFullscreen: process.platform === 'darwin',
        skipTaskbar: true, movable: false, resizable: false,
        enableLargerThanScreen: true,
        hasShadow: false,
        focusable: true,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            zoomFactor: 1.0
        }
    });

    // The video recorder and the scroll capture both read the LIVE desktop via getUserMedia,
    // so this fullscreen overlay window — its selection outline, toolbar and HUD — would
    // otherwise be filmed into the result. Exclude it from all screen capture (including our
    // own getUserMedia) while keeping it visible to the user: WDA_EXCLUDEFROMCAPTURE on
    // Windows, NSWindowSharingNone on macOS. It is set at creation rather than when capture
    // starts so there is no window in which a frame can catch the overlay. Snipper/OCR
    // annotate a pre-captured PNG, so they don't need this.
    if (type === 'video' || type === 'scroll') {
        try { win.setContentProtection(true); } catch (e) { console.error('setContentProtection failed:', e); }
    }

    // macOS system-audio capture. Chromium's getUserMedia desktop-loopback trick (used on
    // Windows) is unavailable on macOS, so the recorder falls back to getDisplayMedia there.
    // This handler fulfils that request with a screen source + loopback audio; the renderer
    // discards the video track and keeps only the audio. Loopback audio works only on
    // supported macOS versions — if unavailable the stream has no audio track and the
    // recorder warns the user (about needing a virtual audio device) and records without it.
    if (type === 'video' && process.platform === 'darwin') {
        try {
            win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
                desktopCapturer.getSources({ types: ['screen'] })
                    .then(sources => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
                    .catch(err => { console.error('DisplayMedia source failed:', err); callback({}); });
            }, { useSystemPicker: false });
        } catch (e) { console.error('setDisplayMediaRequestHandler failed:', e); }
    }

    // Hide Widget during capture
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        state.widgetWindow.hide();
    }

    // __dirname is src/main/services → go up two levels to reach src/renderer
    const rendererPath = path.resolve(__dirname, '../../renderer');

    if (type === 'ocr') win.loadFile(path.join(rendererPath, 'ocr/ocr.html'));
    else if (type === 'video') win.loadFile(path.join(rendererPath, 'recorder/recorder.html'));
    else if (type === 'scroll') win.loadFile(path.join(rendererPath, 'scroller/scroller.html'));
    else win.loadFile(path.join(rendererPath, 'snipper/snipper.html'));

    const level = process.platform === 'darwin' ? 'pop-up-menu' : 'screen-saver';
    win.setAlwaysOnTop(true, level);

    win.webContents.setWindowOpenHandler(() => { return { action: 'deny' }; });

    win.on('closed', () => {
        state.captureWindows = state.captureWindows.filter(w => w !== win);
        if (type === 'ocr' && state.ocrWindow === win) state.ocrWindow = null;
        else if (type === 'video' && state.recorderWindow === win) state.recorderWindow = null;
        else if (type === 'scroll' && state.scrollerWindow === win) state.scrollerWindow = null;
        else if (state.snipperWindow === win) state.snipperWindow = null;

        // End the capture session only once EVERY monitor's overlay is gone, so the
        // widget doesn't flash back while other capture windows are still open.
        if (state.captureWindows.length === 0) {
            state.isCapturing = false;
            if (state.showWidget) toggleWidget(true);
        }
    });

    if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.setKiosk(false);
    }

    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') {
            event.preventDefault();
            closeAllCaptureWindows(); // ESC on any monitor cancels the whole capture
        }
    });

    if (type === 'ocr') state.ocrWindow = win;
    else if (type === 'video') state.recorderWindow = win;
    else if (type === 'scroll') state.scrollerWindow = win;
    else state.snipperWindow = win;
    state.captureWindows.push(win);

    return win;
}

// Close every capture overlay (across all monitors). Pass a window to keep alive — used
// when a video recording starts on one monitor and the overlays on the others must go away.
function closeAllCaptureWindows(exceptWin = null) {
    state.captureWindows.slice().forEach(w => {
        if (w && !w.isDestroyed() && w !== exceptWin) w.close();
    });
}

// The toast window is created ONCE and reused: every toast used to destroy the old
// window and spawn a fresh BrowserWindow — a whole renderer process (~100-300ms of
// CPU) per notification. Now it hides on finish and is repositioned + reshown here.
// Feedback belongs on the display the user is working on (cursor), not always the
// primary one — recomputed per toast since the cursor moves between displays.
function positionToastWindow() {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    state.toastWindow.setBounds({ x: wa.x + wa.width - 370, y: wa.y + 50, width: 320, height: 100 });
}

function showToast(message, type = 'info') {
    try {
        if (state.toastWindow && !state.toastWindow.isDestroyed()) {
            if (state.toastReady) {
                positionToastWindow();
                state.toastWindow.showInactive();
                state.toastWindow.webContents.send('display-toast', message, type);
            } else {
                state.pendingToast = [message, type]; // still loading — delivered on ready
            }
            return;
        }
        state.toastReady = false;
        state.pendingToast = [message, type];
        state.toastWindow = new BrowserWindow({
            width: 320, height: 100,
            frame: false, transparent: true, alwaysOnTop: true,
            skipTaskbar: true, resizable: false, show: false,
            webPreferences: {
                preload: path.join(__dirname, '../../preload/preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true
            }
        });
        state.toastWindow.setAlwaysOnTop(true, 'screen-saver');
        // macOS: also show over fullscreen Spaces (the toast is inactive + click-through,
        // so it can't disturb the fullscreen app). skipTransformProcessType keeps the
        // default process-type transform from flashing windows when the toast appears.
        state.toastWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        state.toastWindow.setIgnoreMouseEvents(true);
        state.toastWindow.on('closed', () => { state.toastWindow = null; state.toastReady = false; });
        state.toastWindow.loadFile(path.join(__dirname, '../../renderer/toast/toast.html'));
        state.toastWindow.once('ready-to-show', () => {
            if (!state.toastWindow || state.toastWindow.isDestroyed()) return;
            state.toastReady = true;
            const pending = state.pendingToast; // latest wins if several queued during load
            state.pendingToast = null;
            if (pending) {
                positionToastWindow();
                state.toastWindow.showInactive();
                state.toastWindow.webContents.send('display-toast', pending[0], pending[1]);
            }
        });
    } catch (e) { console.error('Toast Error:', e); }
}

function toggleWidget(show) {
    if (show) {
        if (!state.widgetWindow || state.widgetWindow.isDestroyed()) {
            createWidgetWindow();
        } else {
            state.widgetWindow.showInactive();
            state.widgetWindow.moveTop();
        }
    } else {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.close();
        }
    }
}

// ── Yüzen widget ────────────────────────────────────────────────────────────
// `widgetPos` DÜĞMENİN ölçeklenmemiş mantıksal konumu, pencerenin değil. Pencere düğmeden
// geniş (panel + düğmeler) ve panelin düğmenin hangi yanında açılacağı `widgetSide`'a bağlı:
//     sağ tarafta: pencere.x = düğme.x - panel genişliği
//     sol tarafta: pencere.x = düğme.x
// Yukarı modda (`widgetUp`) pencere düğmenin üstüne doğru uzun ve düğme onun DİBİNDE.
//
// Ölçüler widget.css ile aynı sayılar; pencere bunların `widgetScale` katı, sayfa da aynı
// oranda zoom'lu çiziliyor.
const WIDGET_PANEL_W = 350;
const WIDGET_BTN_W = 68;
const WIDGET_FULL_W = WIDGET_PANEL_W + WIDGET_BTN_W; // 418
const WIDGET_COLLAPSED_H = 68;
// Menü sütunu: 70 px ofset + 6 × 42 px öğe + 5 × 12 px boşluk = 382, artı alt pay.
const WIDGET_EXPANDED_H = 404;
// Geçmiş paneli: 10 px ofset + 400 px panel + 10 px pay. ⚠ 400'dü, yani panelin KENDİ boyu:
// `top: 10px`le başlayan panelin alt 10 px'i (kenarlığı ve yuvarlak köşeleri) pencerenin
// dışında kalıp kırpılıyordu; yukarı modda (`bottom: 10px`) aynı şekilde üstü.
const WIDGET_HISTORY_H = 420;
// Yukarı moddaki pencere boyu — kapalıyken de, menü ya da geçmiş açıkken de AYNI
// (bkz. widgetWindowRect). En uzun içerik kadar.
const WIDGET_TALL_H = WIDGET_HISTORY_H;
const WIDGET_SNAP = 60;
const WIDGET_MARGIN = 10;
// Düzen geçişinde renderer'ın onayından sonra pencereyi yeni şekline sokmadan önce beklenen
// ekran karesi (bkz. 'relayout-ready').
const WIDGET_RELAYOUT_SETTLE_FRAMES = 3;

// Sürükleme sürerken düğmenin HAM konumu ({ id, x, y }); sürükleme yokken null.
//
// Ham konum imleci izliyor ve deltaları sınırsız biriktiriyor; `state.widgetPos` onun
// çalışma alanına sıkıştırılmış, GÖSTERİLEN hâli. İkisi ayrı olmak zorunda: yalnız
// sıkıştırılmış konumu biriktirmek widget'ı monitör kenarında HAPSEDİYOR — kenardan 10 px
// içeride tutulan düğmeye eklenen her küçük delta yine aynı yere sıkıştırılıyor ve widget
// yan monitöre hiç geçemiyordu (Tauri'de ölçüldü). Ham konum sınırı aşınca yan monitörün
// çalışma alanı devreye giriyor.
let widgetDrag = null;

// Ölçeklenmiş (pencere) ölçüsü.
function widgetPx(v) {
    return Math.round(v * (state.widgetScale || 100) / 100);
}

// Düğmeyi (w × h) monitörün kullanılabilir alanında, kenarlardan `margin` içeride tutar.
function clampToWorkArea(wa, x, y, w, h, margin) {
    const maxX = Math.max(wa.x + margin, wa.x + wa.width - w - margin);
    const maxY = Math.max(wa.y + margin, wa.y + wa.height - h - margin);
    return {
        x: Math.min(Math.max(x, wa.x + margin), maxX),
        y: Math.min(Math.max(y, wa.y + margin), maxY),
    };
}

// Düğmenin monitörü: merkezine en yakın olan.
function widgetDisplayAt(pos) {
    return screen.getDisplayNearestPoint({
        x: Math.round(pos.x + widgetPx(WIDGET_BTN_W) / 2),
        y: Math.round(pos.y + widgetPx(WIDGET_COLLAPSED_H) / 2),
    });
}

// Düğmenin altında panellere yer yoksa true: paneller yukarı açılır.
function isWidgetUpOn(workArea, buttonY) {
    return (workArea.y + workArea.height) - buttonY < widgetPx(WIDGET_HISTORY_H);
}

// Pencerenin dikdörtgeni; `openH` açık panelin ölçeklenmemiş boyu.
//
// Aşağı modda pencere düğmeden başlıyor ve açılınca AŞAĞI uzuyor: üst kenar sabit, içerik
// yerinde. Yukarı modda eskiden açarken hem büyütülüp hem ~336 px YUKARI taşınıyordu
// (düğmenin altı sabit). Ama içerik pencerenin SOL ÜST köşesine bağlı ve yeni şekle geç
// çiziliyor: o karede eski, kapalı içerik yukarıdaki yeni üst kenarda göründü — düğme
// açılışta bir an 336 px yukarı sıçrıyor, kapanışta bir an kayboluyordu (ölçüldü,
// --widget-flash-test). Şimdi yukarı modda pencere kapalıyken de açık boyunda — fazlası
// saydam ve tıklama-geçirgen (setIgnoreMouseEvents, bkz. widget.js) — ve açmak/kapamak
// pencereye HİÇ dokunmuyor, yalnız CSS değişiyor. Şekil yalnız düzen (taraf/yön) değişince
// değişiyor; o geçişi de renderer içeriği gizleyerek örtüyor ('relayout-ready').
function widgetWindowRect(pos, side, up, openH) {
    const x = side === 'left' ? pos.x : pos.x - widgetPx(WIDGET_PANEL_W);
    const h = widgetPx(up ? WIDGET_TALL_H : openH);
    return {
        x: Math.round(x),
        y: Math.round(up ? pos.y + widgetPx(WIDGET_COLLAPSED_H) - h : pos.y),
        width: widgetPx(WIDGET_FULL_W),
        height: h,
    };
}

// Pencereyi düğmenin konumuna ve düzene göre yerleştirir, üstte tutar.
function placeWidget(openH) {
    const win = state.widgetWindow;
    win.setBounds(widgetWindowRect(state.widgetPos, state.widgetSide || 'right', !!state.widgetUp, openH));
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.moveTop();
}

// Renderer'a düzeni (taraf + yön) bildirir.
//  relayout: pencere ŞEKİL DEĞİŞTİRECEK ama henüz dokunulmadı. Renderer içeriği gizleyip yeni
//            sınıfları uyguluyor ve 'relayout-ready' diyor; pencere ancak o zaman yeni şekline
//            giriyor. Yoksa içeriğin geç çizildiği karede düğme 350 px yanda ya da ~350 px
//            yukarıda/aşağıda görünürdü (ölçüldü: taraf değişiminde bir kare +353 px).
//  h:        pencerenin (şimdiki ya da birazdan olacak) CSS yüksekliği; renderer gizlediği
//            içeriği görünüm alanı bu boya ulaşınca açıyor.
//  cursor:   imlecin pencereye göre CSS konumu. Pencere durağan imlecin altında taşınınca
//            renderer'ın bildiği son fare konumu bayatlıyor (bkz. widget.js).
function sendWidgetLayout(relayout, openH) {
    const win = state.widgetWindow;
    const up = !!state.widgetUp;
    const b = win.getBounds();
    const zoom = win.webContents.getZoomFactor() || 1;
    const c = screen.getCursorScreenPoint();
    win.webContents.send('widget-layout', {
        side: state.widgetSide || 'right',
        up,
        relayout,
        h: up ? WIDGET_TALL_H : openH,
        cursor: { x: (c.x - b.x) / zoom, y: (c.y - b.y) / zoom },
    });
}

// Yönü düğmenin şimdiki yerinden yeniden hesaplar, pencereyi kapalı şekline sokar ve düzeni
// bildirir. Yön YALNIZ düğme yer değiştirince hesaplanıyor — bırakınca (finishWidgetDrag),
// açılışta, monitör ve ölçek değişince (burası) — çünkü pencerenin ŞEKLİ ona bağlı: açarken
// hesaplamak açma anında şekil değiştirmek demekti ve giderilen flaş tam olarak buydu.
// Seyrek olaylar; buradaki şekil değişimi örtülmüyor.
function refreshWidgetLayout() {
    state.widgetUp = isWidgetUpOn(widgetDisplayAt(state.widgetPos).workArea, state.widgetPos.y);
    placeWidget(WIDGET_COLLAPSED_H);
    sendWidgetLayout(false, WIDGET_COLLAPSED_H);
}

function createWidgetWindow() {
    // widgetPos stores the unscaled BUTTON logical position. widgetSide tracks left/right.
    state.widgetPos = store.get('widgetPos') || { x: screen.getPrimaryDisplay().workAreaSize.width - 80, y: 100 };
    state.widgetSide = store.get('widgetSide') || 'right';

    // Ensure the saved position is visible on current displays
    ensureWidgetInBounds();
    widgetDrag = null;
    state.widgetUp = isWidgetUpOn(widgetDisplayAt(state.widgetPos).workArea, state.widgetPos.y);
    const rect = widgetWindowRect(state.widgetPos, state.widgetSide, state.widgetUp, WIDGET_COLLAPSED_H);

    state.widgetWindow = new BrowserWindow({
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    state.widgetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    state.widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    state.widgetWindow.loadFile(path.join(__dirname, '../../renderer/widget/widget.html'));

    // Keep widget always on top — re-apply on every show
    state.widgetWindow.on('show', () => {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
            state.widgetWindow.moveTop();
        }
    });

    // Periodic alwaysOnTop refresh to prevent other windows from covering widget.
    // 10s is enough: this is only a safety net — topmost is also re-asserted on 'show'
    // and after every bounds change, so the interval rarely does real work. (Was 3s,
    // which kept waking the process for nothing.)
    state._widgetTopInterval = setInterval(() => {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed() && state.widgetWindow.isVisible()) {
            // Unconditionally re-assert to stay ahead of other topmost windows
            state.widgetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
            state.widgetWindow.moveTop();
        } else if (!state.widgetWindow || state.widgetWindow.isDestroyed()) {
            clearInterval(state._widgetTopInterval);
            state._widgetTopInterval = null;
        }
    }, 10000);

    state.widgetWindow.on('closed', () => {
        widgetDrag = null;
        if (state._widgetTopInterval) {
            clearInterval(state._widgetTopInterval);
            state._widgetTopInterval = null;
        }
    });

    // Notify renderer of the layout and config once it has loaded
    state.widgetWindow.webContents.on('did-finish-load', () => {
        // Şimdiki ölçek: sayfa sonradan yeniden yüklenirse de pencereyle aynı oranda çizilsin.
        state.widgetWindow.webContents.setZoomFactor((state.widgetScale || 100) / 100);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.showInactive();
            state.widgetWindow.moveTop();
        }
        // İlk düzen: renderer içeriği bu gelene kadar gizli tutuyor (`layout-pending`).
        refreshWidgetLayout();
        state.widgetWindow.webContents.send('widget-config', {
            transparent: state.widgetTransparent,
            color: state.widgetColor,
            opacity: state.widgetOpacity !== undefined ? state.widgetOpacity : 100
        });
    });
}

// Sürükleme bitti: kenarlara yapıştır, ekranda tut, göreli konumu kaydet. `raw`: düğmenin
// sıkıştırılmamış bırakma konumu — monitör düğmenin gerçekten bırakıldığı yerden seçiliyor.
function finishWidgetDrag(raw) {
    const BTN_W = widgetPx(WIDGET_BTN_W);
    const COL_H = widgetPx(WIDGET_COLLAPSED_H);
    // Sürükleme boyunca geçerli olan düzen: değişip değişmediğine bakılacak.
    const prevSide = state.widgetSide || 'right';
    const prevUp = !!state.widgetUp;

    const display = widgetDisplayAt(raw);
    const db = display.workArea;

    let finalBtnX = raw.x;
    let finalY = raw.y;

    // Snapping Thresholds (60px)
    if (Math.abs(finalBtnX - db.x) < WIDGET_SNAP) finalBtnX = db.x + WIDGET_MARGIN;
    else if (Math.abs(finalBtnX - (db.x + db.width - BTN_W)) < WIDGET_SNAP) finalBtnX = db.x + db.width - BTN_W - WIDGET_MARGIN;

    if (Math.abs(finalY - db.y) < WIDGET_SNAP) finalY = db.y + WIDGET_MARGIN;
    else if (Math.abs(finalY - (db.y + db.height - COL_H)) < WIDGET_SNAP) finalY = db.y + db.height - COL_H - WIDGET_MARGIN;

    // General clamping to keep it on-screen
    const clamped = clampToWorkArea(db, finalBtnX, finalY, BTN_W, COL_H, WIDGET_MARGIN);
    finalBtnX = Math.round(clamped.x);
    finalY = Math.round(clamped.y);

    const newSide = (finalBtnX < db.x + db.width / 2) ? 'left' : 'right';

    state.widgetSide = newSide;
    state.widgetPos = { x: finalBtnX, y: finalY };
    store.set('widgetPos', state.widgetPos);
    store.set('widgetSide', newSide);

    // Relative coordinates (0.0 to 1.0)
    store.set('widgetDockParams', {
        displayId: display.id,
        relX: (finalBtnX - db.x) / (db.width - BTN_W),
        relY: (finalY - db.y) / (db.height - COL_H),
        side: newSide
    });

    state.widgetUp = isWidgetUpOn(db, finalY);
    if (newSide === prevSide && state.widgetUp === prevUp) {
        // Şekil aynı: yalnız taşınma (kenara yapışma), içerik pencereyle birlikte gidiyor.
        placeWidget(WIDGET_COLLAPSED_H);
        sendWidgetLayout(false, WIDGET_COLLAPSED_H);
    } else {
        // Şekil değişiyor (kısa ↔ uzun ya da sağ ↔ sol). Pencere, renderer içeriği gizleyip
        // 'relayout-ready' diyene kadar son sürükleme konumunda bekliyor; renderer o onayı bir
        // emniyet süresiyle de gönderiyor, yani burada beklemek takılmıyor.
        sendWidgetLayout(true, WIDGET_COLLAPSED_H);
    }
}

function handleWidgetAction(action, data) {
    if (!state.widgetWindow || state.widgetWindow.isDestroyed()) return;

    // Açma/kapama: yön burada HESAPLANMIYOR (bkz. refreshWidgetLayout). Yukarı modda
    // dikdörtgen her durumda aynı, yani bu çağrı pencereyi yerinden oynatmıyor. Bildirim yalnız
    // emniyet: renderer'ın sınıfları bir şekilde kaçtıysa menü yanlış yöne açılmasın.
    const resize = (openH) => {
        placeWidget(openH);
        sendWidgetLayout(false, openH);
    };

    if (action === 'expand' || action === 'collapse-history') {
        resize(WIDGET_EXPANDED_H);
    } else if (action === 'expand-history') {
        resize(WIDGET_HISTORY_H);
    } else if (action === 'collapse') {
        resize(WIDGET_COLLAPSED_H);
    } else if (action === 'relayout-ready') {
        // Renderer içeriği gizledi ve yeni düzeni uyguladı (bkz. sendWidgetLayout): pencere
        // şimdi yeni şekline girebilir. Renderer o anki durumunu da söylüyor ki açık bir panel
        // kapalı boya sıkıştırılmasın.
        //
        // ⚠ Hemen değil, birkaç kare sonra. Renderer iki kare bekleyip onay veriyor ama gizli
        // kare ekrana (GPU → DWM) ondan bir-iki kare sonra çıkıyor; setBounds ise bir sonraki
        // DWM karesinde görünüyor. Pencere o arada taşınırsa eski, görünür içerik yeni yerde
        // çiziliyor. Ölçüldü (--widget-flash-test): gizli kare pencere taşındıktan ~7 ms SONRA
        // ekrandaydı ve bir koşuda dört geçişin birinde düğme bir kare 353 px yanda göründü.
        const s = data && data.state;
        const openH = s === 'history' ? WIDGET_HISTORY_H : s === 'expanded' ? WIDGET_EXPANDED_H : WIDGET_COLLAPSED_H;
        const hz = widgetDisplayAt(state.widgetPos).displayFrequency;
        setTimeout(() => {
            if (state.widgetWindow && !state.widgetWindow.isDestroyed()) resize(openH);
        }, WIDGET_RELAYOUT_SETTLE_FRAMES * 1000 / (hz > 0 ? hz : 60));
    } else if (action === 'drag') {
        // Yeni sürükleme: ham konum düğmenin şimdiki yerinden başlıyor. Renderer'ın mesajları
        // sıralı geliyor (ipcRenderer.send → ipcMain.on), yani Tauri'deki gibi bitmiş bir
        // sürüklemenin geç kalan deltası yok; kimlik yalnız bırakması hiç gelmemiş bir
        // sürüklemenin (ör. pencere sürüklenirken gizlendi) ham konumunu sonrakine taşımıyor.
        const id = data && data.id;
        if (!widgetDrag || (id !== undefined && id !== widgetDrag.id)) {
            widgetDrag = { id, x: state.widgetPos.x, y: state.widgetPos.y };
        }
        // Delta HAM konuma ekleniyor (bkz. widgetDrag): sıkıştırılmış konuma eklenseydi widget
        // monitör kenarında takılırdı.
        widgetDrag.x += (data && data.x) || 0;
        widgetDrag.y += (data && data.y) || 0;
        // Sürükleme SIRASINDA da çalışma alanında tut. Yalnız bırakınca sıkıştırılıyordu:
        // aşağı sürüklenen düğmenin yarısı görev çubuğunun ALTINA giriyor, bırakınca yukarı
        // zıplıyordu (ölçüldü: 40/40). Monitör SIKIŞTIRILMAMIŞ hedeften seçiliyor — sınırı
        // geçen sürükleme yan monitöre atlayabilsin.
        const shown = clampToWorkArea(widgetDisplayAt(widgetDrag).workArea, widgetDrag.x, widgetDrag.y,
            widgetPx(WIDGET_BTN_W), widgetPx(WIDGET_COLLAPSED_H), WIDGET_MARGIN);
        // Diske DEĞİL belleğe: kalıcı yazma 'drag-end'de.
        state.widgetPos = { x: Math.round(shown.x), y: Math.round(shown.y) };
        // Konum DÜĞMENİN koordinatlarında tutuluyor. Eskiden pencerenin getBounds()'undan
        // türetiliyordu: yukarı modda menü açıkken pencerenin üstü düğmenin ~336 px üstündeydi
        // ve bırakınca widget oraya zıplıyordu (ölçüldü: −339 px). Sürüklenirken pencere düzenin
        // KAPALI şeklinde (renderer da sürükleme başlayınca paneli kapatıyor, widget.js). Düzen
        // — dolayısıyla şekil — sürükleme boyunca SABİT: taraf ve yön bırakınca yeniden
        // hesaplanıyor; sürüklerken şekil değiştirmek düğmeyi her eşik geçişinde bir an yanlış
        // yerde gösterirdi.
        placeWidget(WIDGET_COLLAPSED_H);
    } else if (action === 'drag-end') {
        const raw = widgetDrag ? { x: widgetDrag.x, y: widgetDrag.y } : state.widgetPos;
        widgetDrag = null;
        finishWidgetDrag(raw);
    } else if (action === 'open-list') {
        showMain();
    } else if (action === 'note-front-app') {
        require('./paste-service').noteFrontApp();
    } else if (action === 'quickpaste') {
        // On Windows the paste is a bare Ctrl+V into whatever window has the foreground,
        // and the click that opened this menu gave it to the widget. Dropping focus hands
        // it back to the app underneath. macOS re-activates the remembered app instead
        // (see paste-service), so leave its carefully-tuned activation alone.
        if (process.platform === 'win32') {
            try { state.widgetWindow.blur(); } catch (e) { }
        }
        toggleQuickPaste();
    } else if (action === 'capture-draw') {
        require('./capture-service').startCapture('draw');
    } else if (action === 'capture-ocr') {
        require('./capture-service').startCapture('ocr');
    } else if (action === 'capture-video') {
        require('./capture-service').startCapture('video');
    } else if (action === 'capture-scroll') {
        require('./capture-service').startCapture('scroll');
    }
}

function updateWidgetScale(scaleValue) {
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        state.widgetWindow.webContents.setZoomFactor(scaleValue / 100);
        // Pencere yeni ölçekte, kapalı şeklinde. Yön eşiği de ölçekle değişiyor
        // (WIDGET_HISTORY_H × ölçek): yeniden hesaplanıyor.
        refreshWidgetLayout();
    }
}

/**
 * Ensures the widget is within at least one of the current displays.
 * Restores position using relative coordinates for stability during transitions.
 */
function ensureWidgetInBounds() {
    let targetDisplay;
    const s = (state.widgetScale || 100) / 100;
    const BTN_SIZE = Math.round(68 * s);

    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        const winBounds = state.widgetWindow.getBounds();
        targetDisplay = screen.getDisplayMatching(winBounds);
    }

    let dockParams = store.get('widgetDockParams');
    if (!targetDisplay) {
        const displays = screen.getAllDisplays();
        targetDisplay = displays.find(d => d.id === (dockParams && dockParams.displayId)) || screen.getPrimaryDisplay();
    }
    const db = targetDisplay.workArea;
    const safeWidth = Math.max(1, db.width - BTN_SIZE);
    const safeHeight = Math.max(1, db.height - BTN_SIZE);

    // Use relative coordinates if available
    let newX, newY;
    if (dockParams && dockParams.relX !== undefined) {
        newX = db.x + (dockParams.relX * safeWidth);
        newY = db.y + (dockParams.relY * safeHeight);
    } else {
        // Fallback to absolute or default
        newX = state.widgetPos ? state.widgetPos.x : db.x + db.width - BTN_SIZE - 10;
        newY = state.widgetPos ? state.widgetPos.y : db.y + 100;
    }

    // Clamp to screen bounds
    if (newX < db.x) newX = db.x + 10;
    if (newX > db.x + db.width - BTN_SIZE) newX = db.x + db.width - BTN_SIZE - 10;
    if (newY < db.y) newY = db.y + 10;
    if (newY > db.y + db.height - BTN_SIZE) newY = db.y + db.height - BTN_SIZE - 10;

    const newSide = (newX < db.x + db.width / 2) ? 'left' : 'right';

    state.widgetPos = { x: Math.round(newX), y: Math.round(newY) };
    state.widgetSide = newSide;

    store.set('widgetPos', state.widgetPos);
    store.set('widgetSide', state.widgetSide);
    
    // Refresh dock params
    store.set('widgetDockParams', {
        displayId: targetDisplay.id,
        relX: (state.widgetPos.x - db.x) / safeWidth,
        relY: (state.widgetPos.y - db.y) / safeHeight,
        side: newSide
    });
}

/**
 * Called when displays are added/removed/resized.
 */
let activeSyncTimeouts = [];

function handleDisplayChange() {
    // Clear all existing timeouts for previous events
    activeSyncTimeouts.forEach(t => clearTimeout(t));
    activeSyncTimeouts = [];
    
    const runSync = () => {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            ensureWidgetInBounds();
            // Konum değişmiş olabilir: yönü yeniden hesaplıyor, yerleştiriyor, düzeni bildiriyor.
            refreshWidgetLayout();
        }
    };

    // Triple-Check Sequence: catch OS re-layouts during multi-monitor flashes
    activeSyncTimeouts.push(setTimeout(runSync, 500));
    activeSyncTimeouts.push(setTimeout(runSync, 2000));
    activeSyncTimeouts.push(setTimeout(runSync, 5000));
}

// ── Quick-Paste Picker ──────────────────────────────────────────────────────
// A compact clipboard picker opened by a global shortcut. Created with
// focusable:false so it NEVER steals focus from the text field the user is in —
// which is what lets us paste straight into that field after a pick (the
// 'quickpaste-pick' handler puts the text on the clipboard and fires Ctrl+V).
//
// Esc-to-close: the picker is focusable:false so it can't catch a keydown itself.
// We register Esc as a global accelerator only while it's visible (showQuickPaste)
// and drop it again on every 'hide'.
function unregisterQuickPasteEsc() {
    try { if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape'); } catch (e) {}
}

function createQuickPasteWindow() {
    state.quickPasteWindow = new BrowserWindow({
        width: 300,
        height: 380,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        focusable: false,
        backgroundColor: '#00000000',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    state.quickPasteWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    state.quickPasteWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    state.quickPasteWindow.loadFile(path.join(__dirname, '../../renderer/quickpaste/quickpaste.html'));

    state.quickPasteWindow.on('hide', unregisterQuickPasteEsc);
    state.quickPasteWindow.on('closed', () => { state.quickPasteWindow = null; });
}

// Place the picker next to the mouse cursor, flipped/clamped to stay fully on the
// current display's work area.
function positionQuickPasteAtCursor() {
    const W = 300, H = 380, GAP = 12;
    const pt = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(pt).workArea;

    let x = pt.x + GAP;
    let y = pt.y + GAP;
    if (x + W > wa.x + wa.width) x = pt.x - W - GAP;  // flip to the left of the cursor
    if (y + H > wa.y + wa.height) y = pt.y - H - GAP; // flip above the cursor
    x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - W - 8));
    y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - H - 8));

    state.quickPasteWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: H });
}

function showQuickPaste() {
    if (!state.quickPasteWindow || state.quickPasteWindow.isDestroyed()) return;
    positionQuickPasteAtCursor();
    // showInactive (not show) so the user's current app keeps OS keyboard focus.
    state.quickPasteWindow.showInactive();
    state.quickPasteWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    state.quickPasteWindow.moveTop();
    state.quickPasteWindow.webContents.send('quickpaste-show', { count: state.quickPasteCount });
    // Esc closes the picker while it's open (dropped again on 'hide').
    try {
        if (!globalShortcut.isRegistered('Escape')) globalShortcut.register('Escape', hideQuickPaste);
    } catch (e) { /* Esc is a bonus; the X button still closes it */ }
    // Prewarm the paste helper now so the actual Ctrl+V is instant once they click.
    warmPasteHelper();
}

function toggleQuickPaste() {
    if (state.quickPasteWindow && !state.quickPasteWindow.isDestroyed() && state.quickPasteWindow.isVisible()) {
        hideQuickPaste();
        return;
    }
    if (!state.quickPasteWindow || state.quickPasteWindow.isDestroyed()) {
        createQuickPasteWindow();
        state.quickPasteWindow.webContents.once('did-finish-load', showQuickPaste);
    } else {
        showQuickPaste();
    }
}

function hideQuickPaste() {
    if (state.quickPasteWindow && !state.quickPasteWindow.isDestroyed() && state.quickPasteWindow.isVisible()) {
        state.quickPasteWindow.hide();
    }
}

// Yalnız --widget-flash-test: bırakınca sürüklemenin ham konumu temizlenmiş mi?
function debugWidgetDrag() {
    return widgetDrag;
}

module.exports = {
    showMain,
    toggleMain,
    createMainWindow,
    createCapture,
    showToast,
    toggleWidget,
    handleWidgetAction,
    updateWidgetScale,
    handleDisplayChange,
    closeAllCaptureWindows,
    createQuickPasteWindow,
    toggleQuickPaste,
    hideQuickPaste,
    debugWidgetDrag
};
