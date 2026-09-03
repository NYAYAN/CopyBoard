// window.api — Electron preload.js'in Tauri karşılığı.
//
// Bu dosyanın TEK işi, renderer'ın hiç değişmemesi. `preload.js`'in dışa açtığı yüzey
// burada birebir yeniden üretiliyor: aynı metot adları, aynı imzalar, aynı dönüş
// biçimleri. renderer.js, events.js, gallery.js, viewer.js, widget.js, snipper.js,
// quickpaste.js, toast.js ve update-dialog.js bu sayede tek satır değişmiyor.
//
// ── Neden KLASİK script (module değil) ──────────────────────────────────────
// shared/theme.js ve shared/i18n.js, `window.api.theme` ile `window.api.i18n`'i
// YÜKLENİRKEN SENKRON okuyor: theme.js `<html data-theme>` bayrağını ilk karede
// basmak zorunda, yoksa her pencere açık temaya giderken bir kare koyu yanıp söner.
// Bu yüzden api-tauri.js onlardan ÖNCE ve senkron çalışmalı.
//
// ── Senkron veri nereden geliyor ────────────────────────────────────────────
// Electron'da preload `ipcRenderer.sendSync('i18n-get')` yapabiliyordu. Tauri'de
// senkron IPC yok. Yerine ana süreç, pencereyi kurarken `initialization_script` ile
// `window.__COPYBOARD_BOOT__`'u sayfanın kendi scriptlerinden ÖNCE bırakıyor
// (Spike-7'de altı pencerede ölçüldü). Aşağıdaki `boot` o veridir.
(function () {
    'use strict';

    // Electron sürümü de bu dosyayı yüklüyor (aynı HTML'ler iki sürümde de
    // kullanılıyor). Orada `window.api` preload.js tarafından ÇOKTAN kurulmuş
    // oluyor; sessizce çekilip onu bozmadan bırakıyoruz. Faz 7'de Electron
    // kaldırıldığında bu dal da gider.
    const tauri = window.__TAURI__;
    if (!tauri) {
        if (!window.api) {
            console.error('[api] window.__TAURI__ yok ve preload da yok — köprü kurulamadı');
        }
        return;
    }
    const { invoke, Channel } = tauri.core;
    const { listen } = tauri.event;

    // ── Renderer hatalarını ana sürecin günlüğüne yönlendir ──────────────────
    // Webview konsolu paketlenmiş uygulamada hiçbir yere bakmıyor: bir renderer
    // hatası sessizce kayboluyor. Bunlar `copyboard.log`'a düşsün ki kullanıcıda
    // çıkan bir sorunda isteyecek bir şey olsun.
    const forward = (level) => {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            try {
                invoke('debug_log', {
                    message: `[${level}] ` + args.map((a) =>
                        a instanceof Error ? (a.stack || a.message) : String(a)
                    ).join(' '),
                }).catch(() => {});
            } catch (e) { /* köprü henüz hazır değil */ }
        };
    };
    forward('warn');
    forward('error');
    window.addEventListener('error', (e) => {
        invoke('debug_log', { message: `[uncaught] ${e.message} @ ${e.filename}:${e.lineno}` }).catch(() => {});
    });
    window.addEventListener('unhandledrejection', (e) => {
        invoke('debug_log', { message: `[unhandled] ${e.reason}` }).catch(() => {});
    });

    // ── window.close() ──────────────────────────────────────────────────────
    // Electron'da bir BrowserWindow sayfası `window.close()` deyince pencere
    // kapanıyordu; güncelleme diyaloğu ("Daha Sonra") buna dayanıyor. WKWebView
    // bunu yalnız script'in kendi açtığı pencerelerde onurlandırıyor, wry de
    // köprülemiyor — çağrı sessizce yutuluyor ve her zaman üstte duran diyalog
    // yalnız uygulama kapanınca gidiyordu. Çağıran pencereyi Rust tarafı kapatıyor.
    window.close = () => invoke('close_current_window').catch((e) =>
        console.error('[api] close_current_window başarısız:', e)
    );

    const boot = window.__COPYBOARD_BOOT__ || {
        platform: 'darwin',
        i18n: { lang: 'tr', dict: {} },
        theme: { mode: 'dark', resolved: 'dark' },
    };

    // Ateşle-ve-unut: Electron'un `ipcRenderer.send`'i hiçbir şey döndürmüyordu ve
    // çağıranlar da beklemiyordu. Reddedilen bir promise'i yutmak yerine görünür
    // kılıyoruz — sessiz IPC hatası, kovalanması en zor hata türü.
    function send(cmd, args) {
        invoke(cmd, args).catch((err) => {
            console.error(`[api] ${cmd} başarısız:`, err);
        });
    }

    // Cevap bekleyen çağrılar. Hata hâlinde `fallback` dönüyor ki çağıran taraf
    // `undefined` üzerinde patlamasın (galeri boş dizi, ayarlar boş nesne bekliyor).
    function ask(cmd, args, fallback) {
        return invoke(cmd, args).catch((err) => {
            console.error(`[api] ${cmd} başarısız:`, err);
            return fallback;
        });
    }

    // Olay aboneliği. Electron'da `ipcRenderer.on(ch, (_, ...a) => cb(...a))` idi;
    // Tauri tek bir payload taşıyor, o yüzden çok argümanlı kanallar dizi olarak
    // gönderilip burada açılıyor.
    // `listen()` bir PROMISE döndürür ve dinleyici ancak o çözüldüğünde kurulur.
    // Bu yüzden ikisi de promise'i geri veriyor: "hazırım" diyen bir çağrı,
    // dinleyicisinin gerçekten kurulduğunu bekleyebilsin (bkz. onShowToast).
    // Beklemeden haber vermek, ana sürecin olayı dinleyici kurulmadan yayınlaması
    // demek — mesaj sessizce düşer.
    function on(event, cb) {
        return listen(event, (e) => cb(e.payload)).catch((err) => {
            console.error(`[api] '${event}' dinlenemedi:`, err);
        });
    }

    function onSpread(event, cb) {
        return listen(event, (e) =>
            cb(...(Array.isArray(e.payload) ? e.payload : [e.payload]))
        ).catch((err) => {
            console.error(`[api] '${event}' dinlenemedi:`, err);
        });
    }

    // ── "Hazırım" el sıkışması ──────────────────────────────────────────────
    // `listen()` bir promise; dinleyici ancak o çözülünce kuruluyor. Ana süreç ilk
    // durumu erken yayınlarsa mesaj SESSİZCE DÜŞER — bu hata toast'ta, görüntüleyicide
    // ve güncelleme diyaloğunda ayrı ayrı çıktı. Dinleyici gerçekten kurulduktan
    // sonra ana sürece haber veriyoruz; ilk durum ancak o zaman geliyor.
    let readySent = false;
    function ready(listenPromise) {
        return listenPromise.then(() => {
            if (readySent) return;   // pencere başına bir kez yeter
            readySent = true;
            send('window_ready');
        });
    }

    // ── Henüz taşınmamış kanallar ───────────────────────────────────────────
    // Faz 1 yalnız çekirdeği taşıyor. Kalan metotlar TANIMLI kalıyor: renderer
    // açılışta bunların bir kısmını çağırıyor ve `undefined is not a function`
    // sayfayı komple öldürürdü. Her biri bir kez uyarı basıp makul bir boş değer
    // döndürüyor, böylece eksik olan ne varsa konsolda görünür.
    const warned = new Set();
    function todo(name, fallback) {
        return function () {
            if (!warned.has(name)) {
                warned.add(name);
                console.warn(`[api] '${name}' henüz Tauri'ye taşınmadı (Faz 1)`);
            }
            return typeof fallback === 'function' ? fallback() : fallback;
        };
    }

    window.api = {
        // ── Açılış verisi (senkron) ─────────────────────────────────────────
        platform: boot.platform,
        i18n: boot.i18n,
        theme: boot.theme,

        // ── Tema ve dil ─────────────────────────────────────────────────────
        setTheme: (value) => send('set_theme', { value }),
        onThemeChanged: (cb) => on('theme-changed', cb),
        setLanguage: (lang) => send('set_language', { lang }),

        // ── Geçmiş ve ayarlar ───────────────────────────────────────────────
        getHistory: () => ask('get_history', {}, { history: [], favorites: [] }),
        getSettings: () => ask('get_settings', {}, {}),
        onUpdateHistory: (cb) => ready(on('update-history', cb)),

        setAutoStart: (val) => send('set_autostart', { value: !!val }),
        setClipboardPaused: (val) => send('set_clipboard_paused', { value: !!val }),

        // ── Pencere kontrolü ────────────────────────────────────────────────
        closeWindow: () => send('close_window'),
        minimizeWindow: () => send('minimize_window'),
        onResetView: (cb) => on('reset-view', cb),

        // ── Toast ───────────────────────────────────────────────────────────
        // Kayıt olmak aynı zamanda "bu pencere hazır" demektir: Electron'da bunu
        // `ready-to-show` söylüyordu, burada dinleyicinin kurulması söylüyor.
        onShowToast: (cb) => ready(onSpread('display-toast', cb)),
        toastFinished: () => send('toast_finished'),
        toastResize: (height) => send('toast_resize', { height }),

        sendDebugLog: (message) => send('debug_log', { message: String(message) }),
        openExternal: (url) => tauri.core.invoke('plugin:opener|open_url', { url }).catch((e) =>
            console.error('[api] openExternal başarısız:', e)
        ),

        // ── Pano geçmişi ve favoriler ───────────────────────────────────────
        copyItem: (text) => send('copy_item', { text }),
        copyText: (text) => send('copy_text', { text }),
        deleteHistoryItem: (id) => send('delete_history_item', { id }),
        clearHistory: () => send('clear_history'),
        addToFavorites: (item) => send('add_to_favorites', { item }),
        removeFromFavorites: (id) => send('remove_from_favorites', { id }),
        setItemNote: (id, note) => send('set_item_note', { id, note }),
        // Rust tarafındaki `history_items` → JS'te camelCase (Tauri dönüşümü).
        reorderHistory: (history) => send('reorder_history', { historyItems: history }),
        reorderFavorites: (favorites) => send('reorder_favorites', { favorites }),
        setMaxItems: (count) => send('set_max_items', { count: parseInt(count, 10) || 50 }),
        setQuickPasteCount: (count) => send('set_quickpaste_count', { count: parseInt(count, 10) || 20 }),

        // ── Kısayollar ──────────────────────────────────────────────────────
        // preload.js yedi ayrı metot açıyordu; hepsi tek komuta iniyor.
        setShortcut: (s) => send('set_shortcut', { key: 'list', accelerator: s }),
        setImageShortcut: (s) => send('set_shortcut', { key: 'draw', accelerator: s }),
        setVideoShortcut: (s) => send('set_shortcut', { key: 'video', accelerator: s }),
        setOcrShortcut: (s) => send('set_shortcut', { key: 'ocr', accelerator: s }),
        setColorShortcut: (s) => send('set_shortcut', { key: 'color', accelerator: s }),
        setScrollShortcut: (s) => send('set_shortcut', { key: 'scroll', accelerator: s }),
        setPasteShortcut: (s) => send('set_shortcut', { key: 'paste', accelerator: s }),
        setShortcutEnabled: (key, enabled) => send('set_shortcut_enabled', { key, enabled: !!enabled }),

        // ── Ekran yakalama ──────────────────────────────────────────────────
        // Electron kareyi `webContents.send` ile İTİYORDU. Tauri'nin emit'i JSON
        // serialize ediyor — 3,6 MB'lık bir PNG ~15 MB'lık sayı dizisine dönerdi.
        // Bunun yerine ana süreç METADATA itiyor, kareyi buradan ÇEKİYORUZ
        // (`take_capture_frame` ham ArrayBuffer döndürüyor). snipper.js bunu fark
        // etmiyor: eski imza aynen korunuyor.
        onCaptureScreen: (cb) =>
            ready(on('capture-screen', async (meta) => {
                let bytes = null;
                try {
                    bytes = await invoke('take_capture_frame');
                } catch (e) {
                    console.error('[api] kare alınamadı:', e);
                }
                // Tauri'nin IPC'si custom protocol'den postMessage'a düşerse ham
                // yanıt ArrayBuffer yerine milyon elemanlı bir JS dizisi olarak gelir
                // (sebebi genelde CSP'de connect-src eksikliğidir). Sessizce yavaşlamak
                // yerine bunu söyleyip yine de çalışıyoruz.
                if (bytes && !bytes.byteLength && bytes.length) {
                    console.warn('[api] ham yanıt dizi olarak geldi (IPC postMessage\'e düşmüş) — ' +
                                 bytes.length + ' eleman dönüştürülüyor');
                    bytes = new Uint8Array(bytes).buffer;
                }
                cb(bytes, meta.mode, meta.sourceId, meta.quality,
                   meta.width, meta.height, meta.multiMonitor);
            })),
        onCaptureReset: (cb) => on('capture-reset', cb),
        notifyReady: () => send('snip_ready'),
        retryCapture: () => send('capture_retry'),
        claimCaptureMonitor: () => send('capture_claim_monitor'),
        closeSnipper: () => send('snip_close'),

        sendOCR: (dataUrl) => send('ocr_process', { dataUrl }),
        sendCopyImage: (dataUrl) => send('snip_copy_image', { dataUrl }),
        sendCopyColor: (hex) => send('snip_copy_color', { hex }),
        sendSaveImage: (dataUrl) => send('snip_save_image', { dataUrl }),
        // Ham ArrayBuffer: Tauri bunu doğrudan istek gövdesi olarak taşıyor,
        // JSON'a hiç uğramadan.
        sendCopyBuffer: (buffer) => send('snip_copy_buffer', buffer),
        sendSaveBuffer: (buffer) => send('snip_save_buffer', buffer),
        onSaveDialogOpen: (cb) => on('save-dialog-open', cb),

        // ── Kaydırmalı yakalama kare akışı ──────────────────────────────────
        // Electron'da kareler renderer'daki bir getUserMedia masaüstü akışından
        // geliyordu. Şimdi ana süreç ScreenCaptureKit'ten okuyup ZATEN KIRPILMIŞ
        // ham RGBA'yı Channel ile gönderiyor. Sıkıştırma YOK: Spike-5'te JPEG'in
        // kare hızını 14,8'den 8,9'a düşürdüğü ölçüldü.
        //
        // Kare düzeni: u32 seq | u32 w | u32 h | RGBA baytları
        scrollBegin: (rect, onFrame) => {
            const ch = new Channel();
            let lastSeq = -1;
            ch.onmessage = (buf) => {
                const ab = buf instanceof ArrayBuffer ? buf : (buf.buffer || buf);
                if (!ab || ab.byteLength < 12) return;
                const dv = new DataView(ab);
                const seq = dv.getUint32(0, true);
                const w = dv.getUint32(4, true);
                const h = dv.getUint32(8, true);
                if (!w || !h) return;
                // Sıra atlaması bilgi amaçlı: birleştirme zaten en taze kareyi
                // istiyor, düşen kare kayıp değil.
                if (lastSeq >= 0 && seq > lastSeq + 1) {
                    console.warn('[api] ' + (seq - lastSeq - 1) + ' kare atlandı');
                }
                lastSeq = seq;
                const need = w * h * 4;
                const px = new Uint8ClampedArray(ab, 12);
                if (px.length < need) return;
                onFrame(new ImageData(px.subarray(0, need), w, h));
            };
            return invoke('scroll_begin', {
                x: rect.x, y: rect.y, width: rect.w, height: rect.h, channel: ch,
            });
        },
        scrollEnd: () => send('scroll_end'),
        setIgnoreMouseEvents: (ignore) => send('set_ignore_mouse_events', { ignore: !!ignore }),
        // ── Video kaydı ─────────────────────────────────────────────────────
        // Kareler webview'a HİÇ uğramıyor: encode ve mux ana süreçte.
        // `recordChunk` bu yüzden artık yok — imza uyumu için duruyor.
        recordStart: (rect) => invoke('record_start', {
            x: rect.x, y: rect.y, width: rect.w, height: rect.h,
        }),
        recordChunk: () => {},
        recordStop: () => send('record_stop'),
        setVideoQuality: (v) => send('set_video_quality', { value: String(v) }),
        setAudioMic: (v) => send('set_audio_mic', { value: !!v }),
        setAudioSystem: (v) => send('set_audio_system', { value: !!v }),
        getAudioSettings: () => ask('get_audio_settings', {}, { mic: false, system: false }),
        ensureMicPermission: () => ask('ensure_mic_permission', {}, false),

        // ── Galeri ──────────────────────────────────────────────────────────
        getScreenshots: () => ask('get_screenshots', {}, []),
        copyScreenshot: (id) => send('copy_screenshot', { id }),
        deleteScreenshot: (id) => send('delete_screenshot', { id }),
        showScreenshotFile: (id) => send('show_screenshot_file', { id }),
        openScreenshotFolder: () => send('open_screenshot_folder'),
        showScreenshotMenu: (id) => send('screenshot_context_menu', { id }),
        onScreenshotsUpdated: (cb) => on('screenshots-updated', cb),

        // ── Büyük görüntüleyici ─────────────────────────────────────────────
        openScreenshotViewer: (id) => send('open_screenshot_viewer', { id }),
        onViewerImage: (cb) => ready(on('viewer-image', cb)),
        onViewerList: (cb) => on('viewer-list', cb),
        onViewerWindowState: (cb) => on('viewer-window-state', cb),
        viewerNav: (dir) => send('viewer_nav', { dir }),
        viewerSelect: (id) => send('viewer_select', { id }),
        viewerClose: () => send('viewer_close'),
        viewerMinimize: () => send('viewer_minimize'),
        viewerToggleMaximize: () => send('viewer_toggle_maximize'),
        viewerCopyAnnotated: (dataUrl) => send('viewer_copy_annotated', { dataUrl }),
        viewerCompareImages: (ids) => ask('viewer_compare_images', { ids }, []),

        // ── Yüzen widget ────────────────────────────────────────────────────
        widgetAction: (action, data) => send('widget_action', { action, data: data ?? null }),
        // Pencerenin tıklanabilir yüzeyleri. Hit-test ana süreçte yapılıyor:
        // Tauri'nin `set_ignore_cursor_events`'inde `forward` yok ve geçirgen bir
        // pencere macOS'ta hiç mousemove almıyor (BULGU F5-d).
        setHitAreas: (areas, opts) => send('set_hit_areas', {
            areas,
            zoom: (opts && opts.zoom) || 1,
            noteFrontApp: !!(opts && opts.noteFrontApp),
        }),
        onWidgetSide: (cb) => on('widget-side', cb),
        onWidgetDirection: (cb) => on('widget-direction', cb),
        onWidgetConfig: (cb) => ready(on('widget-config', cb)),
        setShowWidget: (v) => send('set_show_widget', { value: !!v }),
        setWidgetTransparent: (v) => send('set_widget_transparent', { value: !!v }),
        setWidgetColor: (v) => send('set_widget_color', { value: String(v) }),
        setWidgetOpacity: (v) => send('set_widget_opacity', { value: parseInt(v, 10) || 100 }),
        setWidgetScale: (v) => send('set_widget_scale', { value: parseInt(v, 10) || 100 }),

        // ── Hızlı yapıştır ──────────────────────────────────────────────────
        quickPastePick: (text) => send('quickpaste_pick', { text }),
        quickPasteDismiss: () => send('quickpaste_dismiss'),
        onQuickPasteShow: (cb) => ready(on('quickpaste-show', cb)),

        // ── Güncelleme ──────────────────────────────────────────────────────
        checkForUpdates: () => send('check_for_updates'),
        downloadUpdate: () => send('download_update'),
        installUpdate: () => send('install_update'),
        onUpdateAvailable: (cb) => on('update-available', cb),
        onUpdateDownloaded: (cb) => on('update-downloaded', cb),
        onDownloadProgress: (cb) => on('download-progress', cb),
        // Dinleyici kurulmadan bilgi istenirse mesaj düşer (BULGU F1-c) —
        // önce dinle, SONRA "hazırım" de.
        onUpdateInfo: (cb) => ready(on('update-info', cb)),
        onUpdateError: (cb) => on('update-error', cb),
    };
})();
