const { ipcMain, BrowserWindow } = require('electron');
const { state, store } = require('../state');

// Core / app-wide IPC: initial data fetch, simple persisted toggles, window chrome.
function registerCoreHandlers() {
    ipcMain.handle('get-history', () => ({ history: state.history, favorites: state.favorites }));
    ipcMain.handle('get-settings', () => ({
        maxItems: state.maxItems, quickPasteCount: state.quickPasteCount, globalShortcut: state.shortcuts.list,
        globalShortcutImage: state.shortcuts.draw, globalShortcutVideo: state.shortcuts.video,
        globalShortcutOcr: state.shortcuts.ocr,
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
    ipcMain.on('toast-finished', () => { if (state.toastWindow && !state.toastWindow.isDestroyed()) state.toastWindow.destroy(); });
    ipcMain.on('debug-log', (e, msg) => console.log('[Renderer Debug]:', msg));
}

module.exports = { registerCoreHandlers };
