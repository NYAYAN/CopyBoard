const { state, store } = require('./state');
const { showToast } = require('./window-manager');
const crypto = require('crypto');

// Broadcast updated data to all windows
function broadcast() {
    const data = { history: state.history, favorites: state.favorites };
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('update-history', data);
    }
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        state.widgetWindow.webContents.send('update-history', data);
    }
}

function addHistory(content) {
    if (!content) return;
    const existingIndex = state.history.findIndex(i => i.content === content);
    if (existingIndex !== -1) state.history.splice(existingIndex, 1);

    state.history.unshift({
        id: crypto.randomUUID(),
        content,
        timestamp: new Date().toISOString()
    });

    while (state.history.length > state.maxItems) state.history.pop();
    store.set('history', state.history);
    broadcast();
}

function deleteHistoryItem(id) {
    const index = state.history.findIndex(i => i.id === id);
    if (index !== -1) {
        state.history.splice(index, 1);
        store.set('history', state.history);
        broadcast();
    }
}

function clearHistory() {
    state.history = [];
    store.set('history', state.history);
    broadcast();
    showToast('Geçmiş Temizlendi.', 'success');
}

// ── Favorites (completely independent from history) ──────────────────────────

function addToFavorites(item) {
    const exists = state.favorites.some(f => f.content === item.content);
    if (!exists) {
        state.favorites.unshift({
            id: crypto.randomUUID(),
            content: item.content,
            timestamp: new Date().toISOString(),
            note: item.note || ''
        });
        store.set('favorites', state.favorites);
        broadcast();
    }
}

function removeFromFavorites(id) {
    const index = state.favorites.findIndex(f => f.id === id);
    if (index !== -1) {
        state.favorites.splice(index, 1);
        store.set('favorites', state.favorites);
        broadcast();
    }
}

function setItemNote(id, note) {
    const favItem = state.favorites.find(i => i.id === id);
    const histItem = state.history.find(i => i.id === id);
    if (favItem) { favItem.note = note; store.set('favorites', state.favorites); }
    if (histItem) { histItem.note = note; store.set('history', state.history); }
    broadcast();
}

function reorderHistory(newHistory) {
    state.history = newHistory;
    store.set('history', state.history);
}

function reorderFavorites(newFavorites) {
    state.favorites = newFavorites;
    store.set('favorites', state.favorites);
    broadcast();
}

function startClipboardWatcher(clipboard) {
    const clipboardInterval = setInterval(() => {
        const t = clipboard.readText();
        if (t && t !== state.lastText) {
            state.lastText = t;
            addHistory(t);
        }
    }, 1000);
    return clipboardInterval;
}

module.exports = {
    addHistory,
    deleteHistoryItem,
    clearHistory,
    addToFavorites,
    removeFromFavorites,
    setItemNote,
    reorderHistory,
    reorderFavorites,
    startClipboardWatcher
};
