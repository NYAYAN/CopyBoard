const { ipcMain, clipboard, dialog, BrowserWindow, app, nativeImage, systemPreferences, screen } = require('electron');
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
let ocrWorker = null;
let ocrWorkerPromise = null;
let ocrIdleTimer = null;

function cancelOcrRelease() {
    if (ocrIdleTimer) { clearTimeout(ocrIdleTimer); ocrIdleTimer = null; }
}

function scheduleOcrRelease() {
    cancelOcrRelease();
    ocrIdleTimer = setTimeout(() => {
        ocrIdleTimer = null;
        if (ocrWorker) {
            try { ocrWorker.terminate(); } catch (e) { }
            ocrWorker = null;
            ocrWorkerPromise = null;
        }
    }, OCR_IDLE_MS);
}

function getOcrWorker() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    if (!ocrWorkerPromise) {
        const Tesseract = require('tesseract.js');
        // eng/tur language data ships with the app (extraResources → resources/tessdata;
        // the repo root in dev), so OCR works offline instead of pulling ~10MB from the
        // CDN on first scan. gzip:false — the bundled files are plain .traineddata.
        // cacheMethod 'none' — we read straight from langPath, so a cache copy would be
        // pure duplication (and the install dir may not even be writable).
        const langPath = app.isPackaged
            ? path.join(process.resourcesPath, 'tessdata')
            : app.getAppPath();
        ocrWorkerPromise = Tesseract.createWorker('eng+tur', 1, {
            langPath, gzip: false, cacheMethod: 'none',
            load_system_dawg: '0', load_freq_dawg: '0'
        })
            .then(w => { ocrWorker = w; return w; })
            .catch(err => { ocrWorkerPromise = null; throw err; });
    }
    return ocrWorkerPromise;
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
                        if (win && !win.isDestroyed() && win.isVisible()) {
                            win.setIgnoreMouseEvents(false);
                            win.moveTop();
                        } else {
                            clearInterval(focusInterval);
                        }
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

    ipcMain.on('snip-save-image', async (e, d) => {
        let win = BrowserWindow.fromWebContents(e.sender);
        if (!win && state.snipperWindow && !state.snipperWindow.isDestroyed()) win = state.snipperWindow;

        const parent = process.platform === 'darwin' ? null : win;
        if (process.platform === 'darwin' && win && !win.isDestroyed()) win.setAlwaysOnTop(false);

        // Async dialog — the sync variant froze the whole main process while open.
        let p = null;
        try {
            const opts = {
                title: 'Kaydet',
                defaultPath: path.join(app.getPath('pictures'), `snip_${Date.now()}.png`),
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
                const buffer = Buffer.from(d.split(',')[1], 'base64');
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
    });

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
            const worker = await getOcrWorker();
            const { data: { text } } = await worker.recognize(Buffer.from(d.split(',')[1], 'base64'));
            const c = text.trim();
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

    // Release the cached OCR worker and any open video stream on quit (best-effort)
    app.on('before-quit', () => {
        cancelOcrRelease();
        endVideoStream(() => { });
        if (ocrWorker) {
            try { ocrWorker.terminate(); } catch (e) { }
            ocrWorker = null;
            ocrWorkerPromise = null;
        }
    });
}

module.exports = { registerCaptureHandlers };
