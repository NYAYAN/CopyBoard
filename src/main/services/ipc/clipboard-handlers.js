const { ipcMain, clipboard } = require('electron');
const { state, store } = require('../state');
const { showToast } = require('../window-manager');
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
}

module.exports = { registerClipboardHandlers };
