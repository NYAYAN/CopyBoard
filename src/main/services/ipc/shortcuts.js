const { ipcMain, globalShortcut } = require('electron');
const { state, store } = require('../state');
const { showMain, showToast, toggleQuickPaste } = require('../window-manager');
const { startCapture } = require('../capture-service');

function registerShortcutHandlers() {
    function updateShortcut(key, shortcut, storeKey) {
        const isValidShortcut = (s) => s && /^[\x00-\x7F]+$/.test(s);

        if (!isValidShortcut(shortcut)) {
            showToast('Geçersiz Kısayol - Sadece ASCII karakterler kullanın', 'error');
            return;
        }

        const prevShortcut = state.shortcuts[key];
        const actionFor = (k) => {
            if (k === 'list') return showMain;
            if (k === 'draw') return () => startCapture('draw');
            if (k === 'video') return () => startCapture('video');
            if (k === 'ocr') return () => startCapture('ocr');
            if (k === 'paste') return toggleQuickPaste;
            return null;
        };
        const action = actionFor(key);
        if (!action) return;

        // Free the previous accelerator before claiming the new one.
        try { globalShortcut.unregister(prevShortcut); } catch (e) { }

        let ok = false;
        try { ok = globalShortcut.register(shortcut, action); } catch (e) { ok = false; }

        if (ok) {
            state.shortcuts[key] = shortcut;
            store.set(storeKey, shortcut);
        } else {
            // register() returns false (without throwing) when the accelerator is already
            // claimed by the OS or another app. Don't persist a dead shortcut: warn the user
            // and restore the previous working binding.
            showToast('Kısayol kaydedilemedi - başka bir uygulama kullanıyor olabilir', 'error');
            try { if (prevShortcut) globalShortcut.register(prevShortcut, action); } catch (e) { }
        }
    }

    // Initial Registration
    try {
        const { list, draw, video, ocr, paste } = state.shortcuts;
        if (list) globalShortcut.register(list, showMain);
        if (draw) globalShortcut.register(draw, () => startCapture('draw'));
        if (video) globalShortcut.register(video, () => startCapture('video'));
        if (ocr) globalShortcut.register(ocr, () => startCapture('ocr'));
        if (paste) globalShortcut.register(paste, toggleQuickPaste);
    } catch (err) {
        console.error('Shortcut registration failed:', err);
    }

    ipcMain.on('set-shortcut', (e, s) => updateShortcut('list', s, 'globalShortcut'));
    ipcMain.on('set-image-shortcut', (e, s) => updateShortcut('draw', s, 'globalShortcutImage'));
    ipcMain.on('set-video-shortcut', (e, s) => updateShortcut('video', s, 'globalShortcutVideo'));
    ipcMain.on('set-ocr-shortcut', (e, s) => updateShortcut('ocr', s, 'globalShortcutOcr'));
    ipcMain.on('set-paste-shortcut', (e, s) => updateShortcut('paste', s, 'globalShortcutPaste'));
}

module.exports = { registerShortcutHandlers };
