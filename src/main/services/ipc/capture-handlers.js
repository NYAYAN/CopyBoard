const { ipcMain, clipboard, dialog, BrowserWindow, app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
// Tesseract will be lazy-loaded in the OCR handler to speed up startup
const { state, store } = require('../state');
const { showToast, closeAllCaptureWindows } = require('../window-manager');
const { addHistory } = require('../history-manager');

// --- OCR worker (lazy + cached) ---
// Creating a Tesseract worker loads ~10MB of eng+tur language data, so we keep
// a single worker alive across scans instead of rebuilding it every time.
let ocrWorker = null;
let ocrWorkerPromise = null;
function getOcrWorker() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    if (!ocrWorkerPromise) {
        const Tesseract = require('tesseract.js');
        ocrWorkerPromise = Tesseract.createWorker('eng+tur', 1, { load_system_dawg: '0', load_freq_dawg: '0' })
            .then(w => { ocrWorker = w; return w; })
            .catch(err => { ocrWorkerPromise = null; throw err; });
    }
    return ocrWorkerPromise;
}

// Screenshot / OCR / video-recording IPC.
function registerCaptureHandlers() {
    ipcMain.on('set-video-quality', (e, v) => { state.videoQuality = v; store.set('videoQuality', v); });

    ipcMain.on('snip-close', () => {
        // Cancel/close from any monitor tears down the whole capture (every overlay). The
        // widget is restored by the windows' 'closed' handler once all of them are gone.
        closeAllCaptureWindows();
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
            showToast('Resim Kopyalandı.', 'success');
        } catch (err) {
            showToast('Kopyalama Hatası: ' + err.message, 'error');
        } finally {
            closeAllCaptureWindows(); // done — tear down every monitor's overlay
        }
    });

    ipcMain.on('snip-save-image', (e, d) => {
        let win = BrowserWindow.fromWebContents(e.sender);
        if (!win && state.snipperWindow && !state.snipperWindow.isDestroyed()) win = state.snipperWindow;

        const parent = process.platform === 'darwin' ? null : win;
        if (process.platform === 'darwin' && win && !win.isDestroyed()) win.setAlwaysOnTop(false);

        const p = dialog.showSaveDialogSync(parent, {
            title: 'Kaydet',
            defaultPath: path.join(app.getPath('pictures'), `snip_${Date.now()}.png`),
            filters: [{ name: 'Images', extensions: ['png'] }]
        });

        if (p) {
            try {
                fs.writeFileSync(p, Buffer.from(d.split(',')[1], 'base64'));
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

    ipcMain.on('record-start', (e) => {
        state.tempVideoPath = path.join(app.getPath('temp'), `temp_video_${Date.now()}.webm`);
        // Recording started on one monitor — close the overlays on the OTHER monitors and
        // remember the recording window so record-stop targets the right one.
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) state.recorderWindow = win;
        closeAllCaptureWindows(win);
    });
    ipcMain.on('record-chunk', (e, arrayBuffer) => { if (state.tempVideoPath) fs.appendFileSync(state.tempVideoPath, Buffer.from(arrayBuffer)); });

    ipcMain.on('record-stop', (e) => {
        try {
            // Hide recorder window immediately to prevent obscuring the save dialog
            if (state.recorderWindow && !state.recorderWindow.isDestroyed()) {
                state.recorderWindow.setAlwaysOnTop(false);
                state.recorderWindow.hide();
            }

            // Small delay to ensure window is hidden
            setTimeout(() => {
                try {
                    const p = dialog.showSaveDialogSync(null, {
                        title: 'Videoyu Kaydet',
                        defaultPath: path.join(app.getPath('videos'), `kayit_${Date.now()}.webm`),
                        filters: [{ name: 'Videos', extensions: ['webm', 'mp4'] }]
                    });

                    if (p) {
                        if (fs.existsSync(state.tempVideoPath) && fs.statSync(state.tempVideoPath).size > 0) {
                            fs.copyFileSync(state.tempVideoPath, p);
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
                            // Optionally open the folder?
                            // require('electron').shell.showItemInFolder(state.tempVideoPath);
                        }
                    }
                } catch (dialogErr) {
                    console.error('Save Dialog Error:', dialogErr);
                    showToast('Kaydetme Penceresi Hatası', 'error');
                } finally {
                    state.tempVideoPath = null;
                    if (state.recorderWindow && !state.recorderWindow.isDestroyed()) state.recorderWindow.close();
                }
            }, 100);

        } catch (err) {
            console.error('Record Stop Error:', err);
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
        }
    });

    // Release the cached OCR worker on quit (best-effort)
    app.on('before-quit', () => {
        if (ocrWorker) {
            try { ocrWorker.terminate(); } catch (e) { }
            ocrWorker = null;
            ocrWorkerPromise = null;
        }
    });
}

module.exports = { registerCaptureHandlers };
