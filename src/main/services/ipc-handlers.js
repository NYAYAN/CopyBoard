const { ipcMain, globalShortcut, clipboard, dialog, BrowserWindow, app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { state, store } = require('./state');
const { showMain, showToast, toggleWidget, handleWidgetAction } = require('./window-manager');
const { addHistory, deleteHistoryItem, clearHistory, addToFavorites, removeFromFavorites, setItemNote, reorderHistory, reorderFavorites } = require('./history-manager');

// Initialize OCR Worker
const ocrWorkerPath = path.join(__dirname, 'ocr-worker.js');
const ocrWorker = new Worker(ocrWorkerPath);
const pendingOcrRequests = new Map();

ocrWorker.on('message', (msg) => {
    const { id, success, result, error } = msg;
    if (pendingOcrRequests.has(id)) {
        const { resolve, reject } = pendingOcrRequests.get(id);
        pendingOcrRequests.delete(id);
        if (success) resolve(result);
        else reject(new Error(error));
    }
});

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
        if (key === 'draw') register(shortcut, () => require('./capture-service').startCapture('draw'));
        if (key === 'video') register(shortcut, () => require('./capture-service').startCapture('video'));
        if (key === 'ocr') register(shortcut, () => require('./capture-service').startCapture('ocr'));
    }

    // Initial Registration
    try {
        const { list, draw, video, ocr } = state.shortcuts;
        if (list) globalShortcut.register(list, showMain);
        if (draw) globalShortcut.register(draw, () => require('./capture-service').startCapture('draw'));
        if (video) globalShortcut.register(video, () => require('./capture-service').startCapture('video'));
        if (ocr) globalShortcut.register(ocr, () => require('./capture-service').startCapture('ocr'));
    } catch (err) {
        console.error('Shortcut registration failed:', err);
    }

    // --- IPC Listeners ---
    ipcMain.handle('get-history', async () => {
        const { getDecompressedHistory, getDecompressedFavorites } = require('./history-manager');
        const history = await getDecompressedHistory();
        const favorites = await getDecompressedFavorites();
        return { history, favorites };
    });
    ipcMain.handle('get-settings', () => ({
        maxItems: state.maxItems, globalShortcut: state.shortcuts.list,
        globalShortcutImage: state.shortcuts.draw, globalShortcutVideo: state.shortcuts.video,
        globalShortcutOcr: state.shortcuts.ocr,
        autoStart: state.autoStart, videoQuality: state.videoQuality,
        showWidget: state.showWidget || false,
        widgetTransparent: state.widgetTransparent || false,
        widgetColor: state.widgetColor || '#8957e5',
        widgetOpacity: state.widgetOpacity !== undefined ? state.widgetOpacity : 100,
        widgetScale: state.widgetScale !== undefined ? state.widgetScale : 100
    }));

    ipcMain.on('set-autostart', (e, v) => { state.autoStart = v; store.set('autoStart', v); });
    ipcMain.on('set-video-quality', (e, v) => { state.videoQuality = v; store.set('videoQuality', v); });
    ipcMain.on('set-show-widget', (e, v) => {
        state.showWidget = v;
        store.set('showWidget', v);
        toggleWidget(v);
    });

    ipcMain.on('set-widget-transparent', (e, v) => {
        state.widgetTransparent = v;
        store.set('widgetTransparent', v);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.webContents.send('widget-config', {
                transparent: v, color: state.widgetColor, opacity: state.widgetOpacity
            });
        }
    });

    ipcMain.on('set-widget-color', (e, v) => {
        state.widgetColor = v;
        store.set('widgetColor', v);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.webContents.send('widget-config', {
                transparent: state.widgetTransparent, color: v, opacity: state.widgetOpacity
            });
        }
    });

    ipcMain.on('set-widget-opacity', (e, v) => {
        state.widgetOpacity = v;
        store.set('widgetOpacity', v);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.webContents.send('widget-config', {
                transparent: state.widgetTransparent, color: state.widgetColor, opacity: v, scale: state.widgetScale
            });
        }
    });

    ipcMain.on('set-widget-scale', (e, v) => {
        state.widgetScale = v;
        store.set('widgetScale', v);
        const { updateWidgetScale } = require('./window-manager');
        updateWidgetScale(v);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.webContents.send('widget-config', {
                transparent: state.widgetTransparent, color: state.widgetColor, opacity: state.widgetOpacity, scale: v
            });
        }
    });

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
        addHistory(text);
        if (state.mainWindow) state.mainWindow.hide();
    });

    ipcMain.on('add-manual-item', (e, content) => {
        addHistory(content);
        showToast('Öğe Eklendi', 'success');
    });

    ipcMain.on('add-to-favorites', (e, item) => addToFavorites(item));
    ipcMain.on('remove-from-favorites', (e, id) => removeFromFavorites(id));
    ipcMain.on('set-item-note', (e, id, note) => setItemNote(id, note));
    ipcMain.on('reorder-history', (e, newHistory) => reorderHistory(newHistory));
    ipcMain.on('reorder-favorites', (e, newFavorites) => reorderFavorites(newFavorites));
    ipcMain.on('delete-history-item', (e, id) => deleteHistoryItem(id));
    ipcMain.on('clear-history', () => clearHistory());

    ipcMain.on('close-window', () => { if (state.mainWindow) state.mainWindow.hide(); });
    ipcMain.on('minimize-window', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) win.minimize();
    });
    ipcMain.on('toast-finished', () => { if (state.toastWindow && !state.toastWindow.isDestroyed()) state.toastWindow.destroy(); });
    ipcMain.on('debug-log', (e, msg) => console.log('[Renderer Debug]:', msg));

    // Updates
    ipcMain.on('check-for-updates', (...args) => require('./update-manager').checkForUpdates(...args));
    ipcMain.on('download-update', (...args) => require('./update-manager').downloadUpdate(...args));
    ipcMain.on('install-update', (...args) => require('./update-manager').installUpdate(...args));
    ipcMain.on('open-url', (e, url) => {
        if (!url || typeof url !== 'string') return;

        // Protocol validation for security (Only allow web URLs)
        const allowedProtocols = ['http:', 'https:'];
        try {
            const parsedUrl = new URL(url);
            if (!allowedProtocols.includes(parsedUrl.protocol)) {
                console.warn(`[Security]: Blocked attempt to open non-web URL: ${url}`);
                return;
            }
            require('electron').shell.openExternal(url);
        } catch (err) {
            console.error('[Security]: Invalid URL provided to open-url:', url);
            return;
        }

        // Close update window if it exists
        if (state.updateWindow && !state.updateWindow.isDestroyed()) {
            state.updateWindow.close();
        }
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

        // Ensure widget is visible again if it was enabled
        if (state.showWidget) toggleWidget(true);
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

    ipcMain.on('snip-copy-v2', (e, arrayBuffer) => {
        try {
            const buffer = Buffer.from(arrayBuffer);

            if (process.platform === 'win32') {
                // Windows: Use PowerShell + .NET to bypass Electron's DPI scaling entirely
                // Write PNG to temp file asynchronously (non-blocking)
                const tmpPath = path.join(app.getPath('temp'), `copyboard_snip_${Date.now()}.png`);
                fs.writeFile(tmpPath, buffer, (err) => {
                    if (err) throw err;

                    // Get actual screen DPI to match Snipping Tool behaviour — prevents blurry paste
                    const cursorPoint = screen.getCursorScreenPoint();
                    const display = screen.getDisplayNearestPoint(cursorPoint);
                    const screenDpi = Math.round(96 * (display.scaleFactor || 1));

                    // Run PowerShell asynchronously so the main thread is never blocked
                    const { exec } = require('child_process');
                    const escapedPath = tmpPath.replace(/\\/g, '\\\\');
                    const psCmd = [
                        `Add-Type -AssemblyName System.Drawing`,
                        `Add-Type -AssemblyName System.Windows.Forms`,
                        // Load PNG bytes for raw PNG clipboard format (what apps like Chrome/Word prefer)
                        `$pngBytes = [System.IO.File]::ReadAllBytes('${escapedPath}')`,
                        `$ms = New-Object System.IO.MemoryStream($pngBytes, 0, $pngBytes.Length)`,
                        // Load bitmap and set correct DPI (prevents Windows resizing it on paste)
                        `$bmp = [System.Drawing.Bitmap]::new('${escapedPath}')`,
                        `$bmp.SetResolution(${screenDpi}, ${screenDpi})`,
                        // Build DataObject with BOTH formats — same as Snipping Tool
                        `$obj = New-Object System.Windows.Forms.DataObject`,
                        `$obj.SetData('PNG', $ms)`,
                        `$obj.SetImage($bmp)`,
                        `[System.Windows.Forms.Clipboard]::SetDataObject($obj, $true)`,
                        `$bmp.Dispose()`,
                        `$ms.Dispose()`
                    ].join('; ');
                    
                    exec(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, { timeout: 10000, windowsHide: true }, (psErr) => {
                        if (psErr) {
                            console.log('[Clipboard] PowerShell failed, using Electron fallback:', psErr.message);
                            const nativeImg = require('electron').nativeImage.createFromBuffer(buffer, { scaleFactor: 1.0 });
                            clipboard.writeImage(nativeImg);
                        }
                        showToast('Resim Kopyalandı.', 'success');
                        try { fs.unlinkSync(tmpPath); } catch (cleanErr) { /* ignore */ }
                    });
                });
            } else {
                // macOS / Linux: Use NativeImage with scaleFactor: 1.0
                const nativeImg = require('electron').nativeImage.createFromBuffer(buffer, { scaleFactor: 1.0 });
                clipboard.writeImage(nativeImg);
                showToast('Resim Kopyalandı.', 'success');
            }
        } catch (err) {
            showToast('Kopyalama Hatası: ' + err.message, 'error');
        }
    });

    ipcMain.on('snip-save-image', (e, arrayBuffer) => {
        const buffer = Buffer.from(arrayBuffer);

        dialog.showSaveDialog(null, {
            title: 'Kaydet',
            defaultPath: path.join(app.getPath('pictures'), `snip_${Date.now()}.png`),
            filters: [{ name: 'Images', extensions: ['png'] }]
        }).then(result => {
            if (!result.canceled && result.filePath) {
                fs.writeFile(result.filePath, buffer, (err) => {
                    if (!err) showToast('Resim Kaydedildi.', 'success');
                    else showToast('Hata: ' + err.message, 'error');
                });
            } else {
                showToast('Kaydetme iptal edildi.', 'info');
            }
        }).catch(err => {
            console.error(err);
        });
    });

    let videoStream = null;

    ipcMain.on('record-start', () => { 
        state.tempVideoPath = path.join(app.getPath('temp'), `temp_video_${Date.now()}.webm`); 
        videoStream = fs.createWriteStream(state.tempVideoPath, { flags: 'a' });
    });
    
    ipcMain.on('record-chunk', (e, arrayBuffer) => { 
        if (videoStream) videoStream.write(Buffer.from(arrayBuffer)); 
    });

    ipcMain.on('record-stop', (e) => {
        if (videoStream) {
            videoStream.end();
            videoStream = null;
        }

        try {
            // Hide recorder window immediately to prevent obscuring the save dialog
            if (state.recorderWindow && !state.recorderWindow.isDestroyed()) {
                state.recorderWindow.setAlwaysOnTop(false);
                state.recorderWindow.hide();
            }

            // Small delay to ensure window is hidden and stream is flushed
            setTimeout(() => {
                try {
                    dialog.showSaveDialog(null, {
                        title: 'Videoyu Kaydet',
                        defaultPath: path.join(app.getPath('videos'), `kayit_${Date.now()}.webm`),
                        filters: [{ name: 'Videos', extensions: ['webm', 'mp4'] }]
                    }).then(result => {
                        const p = result.filePath;
                        if (!result.canceled && p) {
                            if (fs.existsSync(state.tempVideoPath)) {
                                fs.copyFile(state.tempVideoPath, p, err => {
                                    if (err) {
                                        showToast('Kayıt Hatası', 'error');
                                        console.error('Copy Error:', err);
                                    } else {
                                        showToast('Video Kaydedildi.', 'success');
                                        try { fs.unlinkSync(state.tempVideoPath); } catch (e) { /* ignore */ }
                                    }
                                });
                            }
                        } else {
                            // Cancelled - Add temp path to history
                            if (state.tempVideoPath && fs.existsSync(state.tempVideoPath)) {
                                clipboard.writeText(state.tempVideoPath);
                                addHistory(state.tempVideoPath);
                                showToast('Kayıt iptal edildi. Dosya yolu panoya kopyalandı.', 'info');
                            }
                        }
                    }).catch(dialogErr => {
                        console.error('Save Dialog Promise Error:', dialogErr);
                        showToast('Kaydetme Penceresi Hatası', 'error');
                    }).finally(() => {
                        state.tempVideoPath = null;
                        if (state.recorderWindow && !state.recorderWindow.isDestroyed()) state.recorderWindow.close();
                    });
                } catch (dialogErr) {
                    console.error('Save Dialog Error:', dialogErr);
                    showToast('Kaydetme Penceresi Hatası', 'error');
                    state.tempVideoPath = null;
                    if (state.recorderWindow && !state.recorderWindow.isDestroyed()) state.recorderWindow.close();
                }
            }, 300);

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
            const id = crypto.randomUUID();
            const text = await new Promise((resolve, reject) => {
                pendingOcrRequests.set(id, { resolve, reject });
                ocrWorker.postMessage({ id, action: 'recognize', data: d });
            });
            
            const c = text;
            if (c) {
                state.lastText = c;
                clipboard.writeText(c);
                addHistory(c);
                showToast('Metin Kopyalandı.', 'success');
            } else {
                showToast('Metin Bulunamadı.', 'warning');
            }
        } catch (err) { 
            console.error(err); 
            showToast('Tarama Hatası', 'error');
        }
    });

    // Widget Events
    ipcMain.on('widget-action', (e, action, data) => {
        handleWidgetAction(action, data);
    });
}

module.exports = { registerIpcHandlers };
