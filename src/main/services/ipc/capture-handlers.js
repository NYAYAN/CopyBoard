const { ipcMain, clipboard, dialog, BrowserWindow, app, nativeImage, systemPreferences, screen, globalShortcut } = require('electron');
const { t } = require('../i18n');
const fs = require('fs');
const path = require('path');
// Tesseract will be lazy-loaded in the OCR handler to speed up startup
const { state, store } = require('../state');
const { showToast, closeAllCaptureWindows } = require('../window-manager');
const { addHistory } = require('../history-manager');
const { addScreenshot } = require('../screenshot-library');

// --- OCR worker (lazy + cached + idle-released) ---
// Creating a Tesseract worker loads ~10MB of eng+tur language data, so we keep a single
// worker alive across scans instead of rebuilding it every time. But alive-forever costs
// 150MB+ of RSS after one scan, so an idle timer tears it down after 5 minutes without
// OCR; the next scan just pays the ~1-2s warmup again.
const OCR_IDLE_MS = 5 * 60 * 1000;
// Tesseract's createWorker() promise never settles when language loading fails — its internal
// reject only propagates for the core-load step — so the wait is bounded here. Without the
// bound one failure leaves a forever-pending promise in ocrWorkerPromise and every later scan
// awaits it, so OCR stays dead until restart with the "Metin Taranıyor..." toast as the only sign.
const OCR_WORKER_TIMEOUT_MS = 45 * 1000;
// Same reasoning for the scan itself: a worker thread that dies mid-recognize never rejects
// (tesseract.js registers a browser-style onerror that node's worker_threads never calls).
const OCR_SCAN_TIMEOUT_MS = 60 * 1000;
let ocrWorker = null;
let ocrWorkerPromise = null;
let ocrIdleTimer = null;

// Reject with a flagged error if promise hasn't settled in time. The flag marks the worker as
// unusable — tesseract.js rejects with plain strings, so only our own errors carry properties.
function withOcrTimeout(promise, ms, message) {
    let timer = null;
    const bounded = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            const err = new Error(message);
            err.ocrTimeout = true;
            reject(err);
        }, ms);
        promise.then(resolve, reject);
    });
    return bounded.finally(() => clearTimeout(timer));
}

function cancelOcrRelease() {
    if (ocrIdleTimer) { clearTimeout(ocrIdleTimer); ocrIdleTimer = null; }
}

// Drop the cached worker (and any half-finished creation) so the next scan starts clean.
function releaseOcrWorker() {
    const worker = ocrWorker;
    ocrWorker = null;
    ocrWorkerPromise = null;
    if (worker) { try { worker.terminate(); } catch (e) { } }
}

function scheduleOcrRelease() {
    cancelOcrRelease();
    ocrIdleTimer = setTimeout(() => {
        ocrIdleTimer = null;
        releaseOcrWorker();
    }, OCR_IDLE_MS);
}

// eng/tur language data ships with the app (extraResources → resources/tessdata; the repo root
// in dev) so OCR works offline instead of pulling ~10MB from the CDN on first scan.
//
// It is loaded through cachePath, NOT langPath: tesseract.js asks is-electron which environment
// its worker thread is in, gets 'electron' rather than 'node', and therefore treats langPath as
// a URL and hands it to node-fetch — which rejects a plain filesystem path with
// "TypeError: Only absolute URLs are supported" on macOS and Windows alike. Its cache reader is
// a plain fs.readFile, so pointing cachePath at the bundled tessdata loads eng/tur straight off
// disk and never touches the network path. 'readOnly' keeps tesseract.js from writing into the
// install dir — or, when init fails, from deleting the data we shipped.
function getOcrLangOptions() {
    const dir = app.isPackaged
        ? path.join(process.resourcesPath, 'tessdata')
        : app.getAppPath();
    const hasBundledData = ['eng', 'tur'].every(lang => {
        try { return fs.statSync(path.join(dir, `${lang}.traineddata`)).size > 0; }
        catch (err) { return false; }
    });
    if (hasBundledData) return { cachePath: dir, cacheMethod: 'readOnly' };
    // Data missing from the install: let tesseract.js pull it from its CDN and cache the
    // download somewhere writable, so a broken install still scans and only downloads once.
    console.error(`Bundled tessdata not found in ${dir} - falling back to the Tesseract CDN.`);
    return { cachePath: app.getPath('userData'), cacheMethod: 'write' };
}

function createOcrWorker() {
    const Tesseract = require('tesseract.js');
    const creating = Tesseract.createWorker('eng+tur', 1, {
        ...getOcrLangOptions(),
        // Without a handler tesseract.js rethrows worker errors from inside its own message
        // listener, which surfaces as an uncaught exception in the main process (Electron's
        // error dialog) instead of a rejected promise we can turn into a toast.
        errorHandler: err => console.error('OCR worker error:', err)
    });

    return withOcrTimeout(creating, OCR_WORKER_TIMEOUT_MS, t('OCR worker hazırlanamadı (zaman aşımı)'))
        .catch(err => {
            // A worker that finishes after the timeout would sit there holding ~150MB.
            creating.then(w => { try { w.terminate(); } catch (e) { } }, () => { });
            throw err;
        });
}

function getOcrWorker() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    if (!ocrWorkerPromise) {
        ocrWorkerPromise = createOcrWorker()
            .then(w => {
                ocrWorker = w;
                // tesseract.js can't tell when its worker thread dies: it posts to the thread
                // from an async send(), so the failure floats off as an unhandled rejection and
                // recognize() never settles. Watch the thread and drop the cache as soon as it
                // exits, so the next scan rebuilds at once instead of waiting out the scan
                // timeout. A thread that is alive but wedged is still the timeout's job.
                const thread = w.worker;
                if (thread && typeof thread.once === 'function') {
                    thread.once('exit', () => {
                        if (ocrWorker === w) { ocrWorker = null; ocrWorkerPromise = null; }
                    });
                }
                return w;
            })
            .catch(err => { ocrWorkerPromise = null; throw err; });
    }
    return ocrWorkerPromise;
}

// --- Scroll capture: Escape while the overlay is click-through ---
// Once a scroll capture starts, the overlay stops taking mouse events so the user can
// scroll the app underneath it — and the first click into that app takes keyboard focus
// with it, which puts Escape out of reach of the window's own before-input-event handler.
// A global Escape is registered for exactly the length of the scroll phase so cancelling
// always works. It is invasive (Escape belongs to whatever app is in front), so every path
// out of the scroll phase — finish, cancel, window closed, quit — releases it.
let scrollEscapeOwner = null;

function releaseScrollEscape() {
    if (!scrollEscapeOwner) return;
    scrollEscapeOwner = null;
    try { globalShortcut.unregister('Escape'); } catch (err) { console.error('Escape release failed:', err); }
}

// Recording chunks stream to disk through ONE WriteStream — the old
// fs.appendFileSync-per-chunk reopened the file and blocked the main process
// (every window + the clipboard watcher) on each write.
let videoWriteStream = null;

// Close the stream and invoke cb exactly once, whether it flushes cleanly,
// errors (disk full), or was never open. record-stop must not read the temp
// file before this completes.
function endVideoStream(cb) {
    const s = videoWriteStream;
    videoWriteStream = null;
    if (!s || s.destroyed) { cb(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; cb(); } };
    s.on('error', finish);
    try { s.end(finish); } catch (e) { console.error('Video stream end failed:', e); finish(); }
}

// Screenshot / OCR / video-recording IPC.
function registerCaptureHandlers() {
    ipcMain.on('set-video-quality', (e, v) => { state.videoQuality = v; store.set('videoQuality', v); });

    // Recorder audio toggles (microphone + system/computer audio). Persisted so the
    // recorder toolbar remembers the last choice across captures/sessions.
    ipcMain.on('set-audio-mic', (e, v) => { state.audioMic = !!v; store.set('audioMic', state.audioMic); });
    ipcMain.on('set-audio-system', (e, v) => { state.audioSystem = !!v; store.set('audioSystem', state.audioSystem); });
    ipcMain.handle('get-audio-settings', () => ({ mic: !!state.audioMic, system: !!state.audioSystem }));

    // macOS: microphone access is gated by TCC. Prompt (or report current status) before the
    // renderer calls getUserMedia so a denial surfaces as a clear message instead of a silent
    // failure. On other platforms getUserMedia handles its own permission, so report granted.
    ipcMain.handle('ensure-mic-permission', async () => {
        if (process.platform !== 'darwin') return true;
        try {
            if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
            return await systemPreferences.askForMediaAccess('microphone');
        } catch (err) {
            console.error('Mic permission request failed:', err);
            return false;
        }
    });

    ipcMain.on('snip-close', () => {
        // Cancel/close from any monitor tears down the whole capture (every overlay). The
        // widget is restored by the windows' 'closed' handler once all of them are gone.
        closeAllCaptureWindows();
    });

    // The overlay got a screenshot it can't use (empty buffer or a PNG that won't decode).
    // Self-heal instead of surfacing an error: re-capture that display and re-send. The
    // overlay only becomes visible after a usable screenshot arrives ('snip-ready'), so
    // retries are invisible to the user. Bounded per window; when the limit is hit the
    // capture tears down with a toast — the true last resort (e.g. permission revoked).
    const MAX_CAPTURE_RETRIES = 2; // on top of captureDisplay's own 5 grab attempts each
    ipcMain.on('capture-retry', async (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed() || !state.captureWindows.includes(win)) return;

        const giveUp = () => {
            showToast('Ekran görüntüsü alınamadı. Lütfen tekrar deneyin.', 'error');
            closeAllCaptureWindows();
        };

        win.__captureRetries = (win.__captureRetries || 0) + 1;
        if (win.__captureRetries > MAX_CAPTURE_RETRIES) return giveUp();

        // Normally still hidden here; never bake our own overlay into a re-capture.
        if (win.isVisible()) win.hide();

        try {
            const displays = screen.getAllDisplays();
            const display = screen.getDisplayMatching(win.getBounds());
            const index = Math.max(0, displays.findIndex(d => d.id === display.id));
            const cap = await require('../capture-service').captureDisplay(display, index);

            if (win.isDestroyed()) return;
            if (!cap) return giveUp();
            win.webContents.send('capture-screen', cap.pngBuffer, state.lastMode, cap.sourceId,
                state.videoQuality, cap.captureWidth, cap.captureHeight, displays.length > 1);
        } catch (err) {
            console.error('Capture retry failed:', err);
            if (!win.isDestroyed()) giveUp();
        }
    });

    ipcMain.on('capture-claim-monitor', (e) => {
        // A new selection started on one monitor — tell every OTHER monitor to CLEAR its
        // selection (back to full dim). Overlays stay open, dark AND interactive, so only the
        // most-recent selection exists and the user can freely re-select on another monitor.
        // Single-monitor: no other windows, so this is a no-op.
        const sender = BrowserWindow.fromWebContents(e.sender);
        if (!sender) return;
        state.captureWindows.forEach(w => {
            if (w && w !== sender && !w.isDestroyed() && !w.webContents.isDestroyed()) {
                w.webContents.send('capture-reset');
            }
        });
    });

    ipcMain.on('snip-ready', (e) => {
        // Multi-monitor: each display's overlay readies itself — show/focus the sender.
        const win = BrowserWindow.fromWebContents(e.sender);

        if (win && !win.isDestroyed()) {
            win.show();
            win.focus();

            // Only force mouse events ON for snipper/ocr initially.
            // Recorder manages its own state via set-ignore-mouse-events.
            if (state.lastMode !== 'video') {
                win.setIgnoreMouseEvents(false);
            }

            if (process.platform === 'darwin') {
                win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

                // This loop forces the window to top and ensures it receives clicks.
                // However, for VIDEO mode, we want the user to click THROUGH the window usually.
                // So we should NOT force setIgnoreMouseEvents(false) for video.
                if (state.lastMode !== 'video') {
                    const focusInterval = setInterval(() => {
                        if (!win || win.isDestroyed() || !win.isVisible()) {
                            clearInterval(focusInterval);
                            return;
                        }
                        // Once a scroll capture is running the overlay deliberately passes
                        // mouse events to the app underneath so the user can scroll it.
                        // Re-asserting them here would kill scrolling one second in — the
                        // window must stay on top, but it must not take the mouse back.
                        if (!win.__clickThrough) win.setIgnoreMouseEvents(false);
                        win.moveTop();
                    }, 1000);
                }
            }
        }
    });

    ipcMain.on('snip-copy-v2', (e, d) => {
        // The clipboard write needs no window — the image data is already in hand.
        try {
            const base64 = d.split(',')[1];
            const buffer = Buffer.from(base64, 'base64');

            // Renderer pre-compensates by multiplying output by devicePixelRatio.
            // Electron's clipboard.writeImage divides by display scale, so they cancel out.
            // Use scaleFactor 1.0 — the renderer already handled DPI compensation.
            const nativeImg = nativeImage.createFromBuffer(buffer, { scaleFactor: 1.0 });
            clipboard.writeImage(nativeImg);
            // Also keep it in the screenshot gallery (never let a gallery error break the copy).
            try { addScreenshot(buffer); } catch (galleryErr) { console.error('Gallery save failed:', galleryErr); }
            showToast('Resim Kopyalandı.', 'success');
        } catch (err) {
            showToast('Kopyalama Hatası: ' + err.message, 'error');
        } finally {
            closeAllCaptureWindows(); // done — tear down every monitor's overlay
        }
    });

    // Colour-picker mode: the overlay sends the hex under the crosshair. It's text, not an
    // image, so it goes to the clipboard and the history like any other copied string.
    ipcMain.on('snip-copy-color', (e, hex) => {
        try {
            const value = String(hex || '').trim().toLowerCase();
            if (!/^#[0-9a-f]{6}$/.test(value)) throw new Error(t('geçersiz renk kodu'));
            clipboard.writeText(value);
            state.lastText = value; // keep the watcher from re-capturing our own write
            addHistory(value);
            showToast('Renk kodu kopyalandı: ' + value, 'success');
        } catch (err) {
            showToast('Renk kopyalanamadı: ' + err.message, 'error');
        } finally {
            closeAllCaptureWindows();
        }
    });

    // One save dialog at a time. A second request stacks another dialog behind the first,
    // and the extra one surfaces whenever the first is dismissed — long after the moment
    // it belonged to, over whatever the user is doing by then. The renderer no longer
    // sends a second request while an export is in flight; this makes it impossible.
    let saveDialogOpen = false;

    // Ask where to put the PNG and write it. Shared by the data-URL channel the snipper uses
    // and the binary one below, whose images are far too big to move as base64.
    async function saveImage(sender, buffer, namePrefix) {
        if (saveDialogOpen) return;
        saveDialogOpen = true;
        try {
            await runSaveDialog(sender, buffer, namePrefix);
        } finally {
            saveDialogOpen = false;
        }
    }

    async function runSaveDialog(sender, buffer, namePrefix) {
        let win = BrowserWindow.fromWebContents(sender);
        if (!win && state.snipperWindow && !state.snipperWindow.isDestroyed()) win = state.snipperWindow;

        const parent = process.platform === 'darwin' ? null : win;
        if (process.platform === 'darwin' && win && !win.isDestroyed()) win.setAlwaysOnTop(false);

        // Async dialog — the sync variant froze the whole main process while open.
        let p = null;
        try {
            const opts = {
                title: t('Kaydet'),
                defaultPath: path.join(app.getPath('pictures'), `${namePrefix}_${Date.now()}.png`),
                filters: [{ name: 'Images', extensions: ['png'] }]
            };
            const result = parent && !parent.isDestroyed()
                ? await dialog.showSaveDialog(parent, opts)
                : await dialog.showSaveDialog(opts);
            if (!result.canceled && result.filePath) p = result.filePath;
        } catch (dialogErr) {
            console.error('Save dialog failed:', dialogErr);
        }

        if (p) {
            try {
                fs.writeFileSync(p, buffer);
                // Also keep it in the screenshot gallery (never let a gallery error break the save).
                try { addScreenshot(buffer); } catch (galleryErr) { console.error('Gallery save failed:', galleryErr); }
                showToast('Resim Kaydedildi.', 'success');
            } catch (err) {
                showToast('Kaydetme Hatası: ' + err.message, 'error');
            }
            closeAllCaptureWindows(); // saved — tear down every monitor's overlay
        } else {
            if (process.platform === 'darwin' && win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'pop-up-menu');
            showToast('Kaydetme iptal edildi.', 'info');
        }
    }

    ipcMain.on('snip-save-image', (e, d) => {
        saveImage(e.sender, Buffer.from(d.split(',')[1], 'base64'), 'snip');
    });

    // --- Scroll capture ---
    // A stitched page runs to tens of megabytes, so it travels as a binary PNG rather than
    // through the data-URL channels above: base64 would inflate it by a third, and both the
    // encode and the decode are a string copy of the whole image on the main thread.
    ipcMain.on('snip-save-buffer', (e, arrayBuffer) => {
        saveImage(e.sender, Buffer.from(arrayBuffer), 'scroll');
    });

    ipcMain.on('snip-copy-buffer', (e, arrayBuffer) => {
        try {
            const buffer = Buffer.from(arrayBuffer);
            // scaleFactor 1.0: the renderer already worked in physical pixels, exactly as
            // snip-copy-v2 does, so the pasted image is the size the HUD reported.
            clipboard.writeImage(nativeImage.createFromBuffer(buffer, { scaleFactor: 1.0 }));
            try { addScreenshot(buffer); } catch (galleryErr) { console.error('Gallery save failed:', galleryErr); }
            showToast('Resim Kopyalandı.', 'success');
        } catch (err) {
            showToast('Kopyalama Hatası: ' + err.message, 'error');
        } finally {
            closeAllCaptureWindows();
        }
    });

    // The scroll phase is starting: this monitor's overlay is the only one that stays.
    ipcMain.on('scroll-begin', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed()) return;

        // A scroll capture follows one window on one monitor; the other monitors' overlays
        // would just be dimmed panes in the way (and their Escape handler is redundant).
        closeAllCaptureWindows(win);

        // Tells snip-ready's macOS focus loop to stop re-asserting mouse events on this
        // window — from here on the renderer owns that decision.
        win.__clickThrough = true;

        if (scrollEscapeOwner) return; // already armed — never stack registrations
        try {
            if (globalShortcut.register('Escape', () => closeAllCaptureWindows())) {
                scrollEscapeOwner = win;
                win.once('closed', releaseScrollEscape);
            }
        } catch (err) {
            // Not fatal: the overlay's own Escape handler still works whenever it has focus,
            // and the toolbar's cancel button always does.
            console.error('Scroll Escape registration failed:', err);
        }
    });

    ipcMain.on('scroll-end', () => releaseScrollEscape());

    // Video chunks arrive every second and used to be written with fs.appendFileSync on
    // the MAIN process — at high quality that's a multi-MB synchronous disk write that
    // froze every window and IPC handler once a second for the whole recording. A write
    ipcMain.on('record-start', (e) => {
        state.tempVideoPath = path.join(app.getPath('temp'), `temp_video_${Date.now()}.webm`);
        endVideoStream(() => { }); // paranoia: a leftover stream from an aborted run
        videoWriteStream = fs.createWriteStream(state.tempVideoPath);
        videoWriteStream.on('error', (err) => console.error('Video temp write failed:', err));
        // Recording started on one monitor — close the overlays on the OTHER monitors and
        // remember the recording window so record-stop targets the right one.
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) state.recorderWindow = win;
        closeAllCaptureWindows(win);
    });
    ipcMain.on('record-chunk', (e, arrayBuffer) => {
        if (videoWriteStream && !videoWriteStream.destroyed) videoWriteStream.write(Buffer.from(arrayBuffer));
    });

    ipcMain.on('record-stop', (e) => {
        try {
            // Hide recorder window immediately to prevent obscuring the save dialog
            if (state.recorderWindow && !state.recorderWindow.isDestroyed()) {
                state.recorderWindow.setAlwaysOnTop(false);
                state.recorderWindow.hide();
            }

            // Small delay to ensure window is hidden. The stream is flushed BEFORE the
            // save dialog opens — it copies the temp file, so the last chunks must be
            // on disk first.
            setTimeout(() => {
                endVideoStream(async () => {
                    try {
                        // Async dialog: the sync variant froze the whole main process
                        // (clipboard watcher, toasts, tray) for as long as it stayed open.
                        const { canceled, filePath } = await dialog.showSaveDialog({
                            title: 'Videoyu Kaydet',
                            defaultPath: path.join(app.getPath('videos'), `kayit_${Date.now()}.webm`),
                            filters: [{ name: 'Videos', extensions: ['webm', 'mp4'] }]
                        });

                        if (!canceled && filePath) {
                            if (state.tempVideoPath && fs.existsSync(state.tempVideoPath) && fs.statSync(state.tempVideoPath).size > 0) {
                                await fs.promises.copyFile(state.tempVideoPath, filePath);
                                showToast('Video Kaydedildi.', 'success');
                                try { fs.unlinkSync(state.tempVideoPath); } catch (err) { console.error('Temp deletion failed:', err); }
                            } else {
                                showToast('Hata: Video verisi alınamadı. Kayıt başarısız.', 'error');
                            }
                        } else {
                            // Cancelled - Add temp path to history
                            if (state.tempVideoPath && fs.existsSync(state.tempVideoPath)) {
                                clipboard.writeText(state.tempVideoPath); // Copy to system clipboard for Windows/Mac
                                addHistory(state.tempVideoPath);
                                showToast('Kayıt iptal edildi. Dosya yolu panoya kopyalandı.', 'info');
                            }
                        }
                    } catch (dialogErr) {
                        console.error('Save Dialog Error:', dialogErr);
                        showToast('Kaydetme Penceresi Hatası', 'error');
                    } finally {
                        state.tempVideoPath = null;
                        if (state.recorderWindow && !state.recorderWindow.isDestroyed()) state.recorderWindow.close();
                    }
                });
            }, 100);

        } catch (err) {
            console.error('Record Stop Error:', err);
            endVideoStream(() => { });
            if (state.recorderWindow && !state.recorderWindow.isDestroyed()) state.recorderWindow.close();
        }
    });

    ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, options);
    });

    ipcMain.on('ocr-process', async (e, d) => {
        // Close every monitor's overlay before running OCR (image data is already in hand).
        closeAllCaptureWindows();

        cancelOcrRelease(); // never tear the worker down while a scan is about to use it
        showToast('Metin Taranıyor...', 'info');
        try {
            const image = Buffer.from(d.split(',')[1], 'base64');
            let reusedWorker = false;
            const scan = async () => {
                reusedWorker = !!ocrWorker; // a worker held over from an earlier scan may have died
                const worker = await getOcrWorker();
                const { data: { text } } = await withOcrTimeout(
                    worker.recognize(image), OCR_SCAN_TIMEOUT_MS, t('Metin taranamadı (zaman aşımı)'));
                return text.trim();
            };

            let c;
            try {
                c = await scan();
            } catch (firstErr) {
                if (firstErr && firstErr.ocrTimeout) releaseOcrWorker(); // wedged, never reuse it
                // Retry only the fault a retry can fix: a worker held over from an earlier scan
                // that has since died or wedged. When it was built for this scan the failure is
                // the image or the environment, and rebuilding would burn a warm worker to fail
                // in exactly the same way.
                if (!reusedWorker) throw firstErr;
                console.error('OCR failed on the cached worker, retrying with a fresh one:', firstErr);
                releaseOcrWorker();
                c = await scan();
            }

            if (c) {
                state.lastText = c;
                clipboard.writeText(c);
                addHistory(c);
                showToast('Metin Kopyalandı.', 'success');
            } else {
                showToast('Metin bulunamadı.', 'info');
            }
        } catch (err) {
            console.error(err);
            showToast('Metin tanıma başarısız oldu.', 'error');
        } finally {
            scheduleOcrRelease(); // free the ~150MB worker after 5 idle minutes
        }
    });

    // Release the cached OCR worker, any open video stream and a live scroll capture's
    // global Escape on quit (best-effort)
    app.on('before-quit', () => {
        cancelOcrRelease();
        endVideoStream(() => { });
        releaseOcrWorker();
        releaseScrollEscape();
    });
}

module.exports = { registerCaptureHandlers };
