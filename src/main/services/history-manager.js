const { state, store } = require('./state');
const { showToast } = require('./window-manager');
const crypto = require('crypto');

function addHistory(content) {
    if (!content) return;
    const existingIndex = state.history.findIndex(i => i.content === content);
    let isFav = false;
    if (existingIndex !== -1) {
        isFav = state.history[existingIndex].isFavorite;
        state.history.splice(existingIndex, 1);
    }
    const newItem = {
        id: crypto.randomUUID(),
        content,
        timestamp: new Date().toISOString(),
        isFavorite: isFav
    };
    state.history.unshift(newItem);
    if (state.history.length > state.maxItems) {
        let deleted = false;
        for (let i = state.history.length - 1; i >= 0; i--) {
            if (!state.history[i].isFavorite) {
                state.history.splice(i, 1);
                deleted = true;
                break;
            }
        }
        if (!deleted && state.history.length > state.maxItems) state.history.pop();
    }
    store.set('history', state.history);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('update-history', state.history);
    }
}

function deleteHistoryItem(id, source) {
    const index = state.history.findIndex(i => i.id === id);
    if (index !== -1) {
        const item = state.history[index];

        if (source === 'favorites') {
            state.history.splice(index, 1);
        } else {
            if (item.isFavorite) {
                item.hiddenFromHistory = true;
            } else {
                state.history.splice(index, 1);
            }
        }

        store.set('history', state.history);
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.webContents.send('update-history', state.history);
        }
    }
}

function clearHistory() {
    state.history.forEach(item => {
        if (item.isFavorite) item.hiddenFromHistory = true;
    });
    state.history = state.history.filter(i => i.isFavorite);

    store.set('history', state.history);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('update-history', state.history);
    }
    showToast('Geçmiş Temizlendi (Favoriler Saklandı).', 'success');
}

function toggleFavorite(id) {
    const item = state.history.find(i => i.id === id);
    if (item) {
        item.isFavorite = !item.isFavorite;
        if (!item.isFavorite) item.hiddenFromHistory = false;
        store.set('history', state.history);
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.webContents.send('update-history', state.history);
        }
    }
}

function setItemNote(id, note) {
    const item = state.history.find(i => i.id === id);
    if (item) {
        item.note = note;
        store.set('history', state.history);
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.webContents.send('update-history', state.history);
        }
    }
}

function reorderHistory(newHistory) {
    state.history = newHistory;
    store.set('history', state.history);
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
    toggleFavorite,
    setItemNote,
    reorderHistory,
    startClipboardWatcher
};
