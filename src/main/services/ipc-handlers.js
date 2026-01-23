const { ipcMain, globalShortcut, clipboard, dialog, BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const { state, store } = require('./state');
const { showMain, showToast } = require('./window-manager');
const { addHistory, deleteHistoryItem, clearHistory, toggleFavorite, setItemNote, reorderHistory } = require('./history-manager');
const { startCapture } = require('./capture-service');
const { checkForUpdates, downloadUpdate, installUpdate } = require('./update-manager');

function registerIpcHandlers() {
    // --- Shortcuts ---
    function updateShortcut(key, shortcut, storeKey) {
        const isValidShortcut = (s) => s && /^[\x00-\x7F]+$/.test(s);

        if (!isValidShortcut(shortcut)) {
            showToast('Geçersiz Kısayol - Sadece ASCII karakterler kullanın', 'error');
            return;
        }

        try { globalShortcut.unregister(state.shortcuts[key]); } catch (e) { }
        state.shortcuts[key] = shortcut;
        store.set(storeKey, shortcut);

        // Helper for registering
        const register = (k, action) => {
            globalShortcut.register(k, action);
        };

        if (key === 'list') register(shortcut, showMain);
        // Use helper to invoke services
        if (key === 'draw') register(shortcut, () => startCapture('draw'));
        if (key === 'video') register(shortcut, () => startCapture('video'));
        if (key === 'ocr') register(shortcut, () => startCapture('ocr'));
    }

    // Initial Registration
    try {
        const { list, draw, video, ocr } = state.shortcuts;
        if (list) globalShortcut.register(list, showMain);
        if (draw) globalShortcut.register(draw, () => startCapture('draw'));
        if (video) globalShortcut.register(video, () => startCapture('video'));
        if (ocr) globalShortcut.register(ocr, () => startCapture('ocr'));
    } catch (err) {
        console.error('Shortcut registration failed:', err);
    }

    // --- IPC Listeners ---
    ipcMain.handle('get-history', () => state.history);
    ipcMain.handle('get-settings', () => ({
        maxItems: state.maxItems, globalShortcut: state.shortcuts.list,
        globalShortcutImage: state.shortcuts.draw, globalShortcutVideo: state.shortcuts.video,
        globalShortcutOcr: state.shortcuts.ocr,
        autoStart: state.autoStart, videoQuality: state.videoQuality
    }));

    ipcMain.on('set-autostart', (e, v) => { state.autoStart = v; store.set('autoStart', v); });
    ipcMain.on('set-video-quality', (e, v) => { state.videoQuality = v; store.set('videoQuality', v); });

    ipcMain.on('set-shortcut', (e, s) => updateShortcut('list', s, 'globalShortcut'));
    ipcMain.on('set-image-shortcut', (e, s) => updateShortcut('draw', s, 'globalShortcutImage'));
    ipcMain.on('set-video-shortcut', (e, s) => updateShortcut('video', s, 'globalShortcutVideo'));
    ipcMain.on('set-ocr-shortcut', (e, s) => updateShortcut('ocr', s, 'globalShortcutOcr'));

    ipcMain.on('set-max-items', (e, count) => {
        state.maxItems = count;
        store.set('maxItems', count);
        if (state.history.length > count) {
            state.history = state.history.slice(0, count);
            store.set('history', state.history);
            if (state.mainWindow && !state.mainWindow.isDestroyed()) {
                state.mainWindow.webContents.send('update-history', state.history);
            }
        }
    });

    ipcMain.on('copy-item', (e, text) => {
        clipboard.writeText(text);
        state.lastText = text;
        if (state.mainWindow) state.mainWindow.hide();
    });

    ipcMain.on('add-manual-item', (e, content) => {
        addHistory(content);
        showToast('Öğe Eklendi', 'success');
    });

    ipcMain.on('toggle-favorite', (e, id) => toggleFavorite(id));
    ipcMain.on('set-item-note', (e, id, note) => setItemNote(id, note));
    ipcMain.on('reorder-history', (e, newHistory) => reorderHistory(newHistory));
    ipcMain.on('delete-history-item', (e, id, source) => deleteHistoryItem(id, source));
    ipcMain.on('clear-history', () => clearHistory());

    ipcMain.on('close-window', () => { if (state.mainWindow) state.mainWindow.hide(); });
    ipcMain.on('minimize-window', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) win.minimize();
    });
    ipcMain.on('toast-finished', () => { if (state.toastWindow && !state.toastWindow.isDestroyed()) state.toastWindow.destroy(); });
    ipcMain.on('debug-log', (e, msg) => console.log('[Renderer Debug]:', msg));

    // Updates
    ipcMain.on('check-for-updates', checkForUpdates);
    ipcMain.on('download-update', downloadUpdate);
    ipcMain.on('install-update', installUpdate);
    ipcMain.on('open-url', (e, url) => {
        require('electron').shell.openExternal(url);
        // Close update window if it exists
        if (state.updateWindow && !state.updateWindow.isDestroyed()) {
            state.updateWindow.close();
        }
        // Also try to close via browserwindow from sender if needed, though update-manager handles its own window variable.
        // We will rely on the renderer closing itself or update-manager handling it.
    });

    // Capture / Snipper
    ipcMain.on('snip-close', (e) => {
        let win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed()) {
            // Fallback
            if (state.snipperWindow && !state.snipperWindow.isDestroyed()) win = state.snipperWindow;
            else if (state.ocrWindow && !state.ocrWindow.isDestroyed()) win = state.ocrWindow;
            else if (state.recorderWindow && !state.recorderWindow.isDestroyed()) win = state.recorderWindow;
        }
        if (win && !win.isDestroyed()) win.close();
    });

    ipcMain.on('snip-ready', () => {
        let win = state.snipperWindow;
        if (state.lastMode === 'ocr') win = state.ocrWindow;
        if (state.lastMode === 'video') win = state.recorderWindow;

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
        let win = state.snipperWindow;
        if (win && !win.isDestroyed()) {
            try {
                const img = require('electron').nativeImage.createFromDataURL(d);
                clipboard.writeImage(img);
                showToast('Resim Kopyalandı.', 'success');
            } catch (err) {
                showToast('Kopyalama Hatası: ' + err.message, 'error');
            }
            setTimeout(() => win.close(), 100);
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
            fs.writeFileSync(p, Buffer.from(d.split(',')[1], 'base64'));
            showToast('Resim Kaydedildi.', 'success');
            if (win && !win.isDestroyed()) win.close();
        } else {
            if (process.platform === 'darwin' && win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'pop-up-menu');
            showToast('Kaydetme iptal edildi.', 'info');
        }
    });

    ipcMain.on('record-start', () => { state.tempVideoPath = path.join(app.getPath('temp'), `temp_video_${Date.now()}.webm`); });
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
                        if (fs.existsSync(state.tempVideoPath)) {
                            fs.copyFileSync(state.tempVideoPath, p);
                            showToast('Video Kaydedildi.', 'success');
                            try { fs.unlinkSync(state.tempVideoPath); } catch (err) { console.error('Temp deletion failed:', err); }
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
        let win = BrowserWindow.fromWebContents(e.sender);
        if (!win && state.ocrWindow && !state.ocrWindow.isDestroyed()) win = state.ocrWindow;
        if (win && !win.isDestroyed()) win.close();

        showToast('Metin Taranıyor...', 'info');
        try {
            const worker = await Tesseract.createWorker('eng+tur', 1, { load_system_dawg: '0', load_freq_dawg: '0' });
            const { data: { text } } = await worker.recognize(Buffer.from(d.split(',')[1], 'base64'));
            await worker.terminate();
            const c = text.trim();
            if (c) {
                state.lastText = c;
                clipboard.writeText(c);
                addHistory(c);
                showToast('Metin Kopyalandı.', 'success');
            }
        } catch (err) { console.error(err); }
    });
}

module.exports = { registerIpcHandlers };
