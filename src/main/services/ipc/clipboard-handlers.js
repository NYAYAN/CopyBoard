const { ipcMain, clipboard } = require('electron');
const { state, store } = require('../state');
const { showToast, hideQuickPaste } = require('../window-manager');
const { sendPasteKeystroke, ensureAccessibility } = require('../paste-service');
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

        // macOS refuses the synthetic Cmd+V without Accessibility. Prompt (the system
        // dialog has an "Open System Settings" button) and say what happened, rather
        // than leaving the user staring at an unchanged text field — the item is on the
        // clipboard either way, so Cmd+V by hand still works.
        if (!ensureAccessibility(true)) {
            showToast('Otomatik yapıştırma için Erişilebilirlik izni gerekli. Öğe panoya kopyalandı — Cmd+V ile yapıştırabilirsiniz.', 'error');
            return;
        }

        // Small beat so the picker is hidden and the clipboard has settled before Ctrl+V.
        setTimeout(() => {
            sendPasteKeystroke((reason) => {
                // macOS only. Automation is a separate grant from Accessibility, so we can
                // land here even though the check above passed.
                showToast(
                    reason === 'automation'
                        ? 'Otomatik yapıştırma engellendi: CopyBoard\'un "System Events" uygulamasını kontrol etmesine izin verilmedi. Öğe panoya kopyalandı — Cmd+V ile yapıştırabilirsiniz.'
                        : 'Otomatik yapıştırma başarısız oldu. Öğe panoya kopyalandı — Cmd+V ile yapıştırabilirsiniz.',
                    'error'
                );
            });
        }, 90);
    });

    ipcMain.on('quickpaste-dismiss', () => hideQuickPaste());

    ipcMain.on('add-to-favorites', (e, item) => addToFavorites(item));
    ipcMain.on('remove-from-favorites', (e, id) => removeFromFavorites(id));
    ipcMain.on('set-item-note', (e, id, note) => setItemNote(id, note));
    ipcMain.on('reorder-history', (e, newHistory) => reorderHistory(newHistory));
    ipcMain.on('reorder-favorites', (e, newFavorites) => reorderFavorites(newFavorites));
    ipcMain.on('delete-history-item', (e, id) => deleteHistoryItem(id));
    ipcMain.on('clear-history', () => clearHistory());
}

module.exports = { registerClipboardHandlers };
