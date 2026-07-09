const { ipcMain, clipboard } = require('electron');
const { state, store } = require('../state');
const { showToast, hideQuickPaste } = require('../window-manager');
const { sendPasteKeystroke } = require('../paste-service');
const {
    addHistory, deleteHistoryItem, clearHistory,
    addToFavorites, removeFromFavorites, setItemNote,
    reorderHistory, reorderFavorites, broadcast
} = require('../history-manager');

// Clipboard history + favorites IPC.
function registerClipboardHandlers() {
    ipcMain.on('set-max-items', (e, count) => {
        // Clamp to a sane range so a pathological value can't bloat memory/render cost
        const n = Math.max(1, Math.min(parseInt(count, 10) || 50, 500));
        state.maxItems = n;
        store.set('maxItems', n);
        if (state.history.length > n) {
            state.history = state.history.slice(0, n);
            store.set('history', state.history);
            broadcast(); // keep BOTH the main window and the widget in sync
        }
    });

    // How many recent history items the quick-paste picker shows (1..100).
    ipcMain.on('set-quickpaste-count', (e, count) => {
        const n = Math.max(1, Math.min(parseInt(count, 10) || 20, 100));
        state.quickPasteCount = n;
        store.set('quickPasteCount', n);
    });

    ipcMain.on('copy-item', (e, text) => {
        clipboard.writeText(text);
        state.lastText = text;
        addHistory(text);
        if (state.mainWindow) state.mainWindow.hide();
    });

    // Quick-paste picker: put the chosen item on the clipboard, hide the (non-focusable)
    // picker, then paste straight into the field the user was in — see paste-service.
    ipcMain.on('quickpaste-pick', (e, text) => {
        if (!text) return;
        clipboard.writeText(text);
        state.lastText = text; // pre-seed so the 1s watcher doesn't re-capture it as "new"
        hideQuickPaste();
        // Small beat so the picker is hidden and the clipboard has settled before Ctrl+V.
        setTimeout(() => { sendPasteKeystroke(); }, 90);
    });

    ipcMain.on('quickpaste-dismiss', () => hideQuickPaste());

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
}

module.exports = { registerClipboardHandlers };
