const { ipcMain, BrowserWindow, app } = require('electron');
const { state, store } = require('../state');

// Core / app-wide IPC: initial data fetch, simple persisted toggles, window chrome.
function registerCoreHandlers() {
    ipcMain.handle('get-history', () => ({ history: state.history, favorites: state.favorites }));
    ipcMain.handle('get-settings', () => ({
        appVersion: app.getVersion(),
        maxItems: state.maxItems, quickPasteCount: state.quickPasteCount, globalShortcut: state.shortcuts.list,
        globalShortcutImage: state.shortcuts.draw, globalShortcutVideo: state.shortcuts.video,
        globalShortcutOcr: state.shortcuts.ocr,
        globalShortcutColor: state.shortcuts.color,
        shortcutsEnabled: state.shortcuts.enabled,
        globalShortcutPaste: state.shortcuts.paste,
        autoStart: state.autoStart, videoQuality: state.videoQuality,
        clipboardPaused: state.clipboardPaused || false,
        showWidget: state.showWidget || false,
        widgetTransparent: state.widgetTransparent || false,
        widgetColor: state.widgetColor || '#8957e5',
        widgetOpacity: state.widgetOpacity !== undefined ? state.widgetOpacity : 100,
        widgetScale: state.widgetScale !== undefined ? state.widgetScale : 100
    }));

    ipcMain.on('set-autostart', (e, v) => { state.autoStart = v; store.set('autoStart', v); });
    ipcMain.on('set-clipboard-paused', (e, v) => { state.clipboardPaused = v; store.set('clipboardPaused', v); });

    ipcMain.on('close-window', () => { if (state.mainWindow) state.mainWindow.hide(); });
    ipcMain.on('minimize-window', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) win.minimize();
    });
    // Hide, don't destroy: the toast window is reused across toasts (see showToast) so a
    // notification never costs a renderer-process spawn again.
    ipcMain.on('toast-finished', () => { if (state.toastWindow && !state.toastWindow.isDestroyed()) state.toastWindow.hide(); });

    // The toast renderer measures its laid-out card and asks for a window that fits it:
    // the window is a fixed-size OS rectangle, so a message longer than the default
    // height was simply CLIPPED (the tail of the text was unreadable). Grows downward
    // from the window's current top-left, so the top-right anchor never moves.
    ipcMain.on('toast-resize', (e, height) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed() || win !== state.toastWindow) return;
        const h = Math.max(60, Math.min(Math.round(height) || 100, 400)); // clamp: never off-screen tall
        const b = win.getBounds();
        if (b.height === h) return;
        win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
    });
    ipcMain.on('debug-log', (e, msg) => console.log('[Renderer Debug]:', msg));
}

module.exports = { registerCoreHandlers };
