const { state, store } = require('./state');
const { showToast } = require('./window-manager');
const crypto = require('crypto');

// History items are stored WHOLE or not at all — never truncated, because a truncated
// entry would silently paste corrupted content later. Copies larger than this simply
// don't enter the list (the OS clipboard is unaffected). The gate keeps the config file
// bounded: it's rewritten on every change and read synchronously at startup.
const MAX_ITEM_CHARS = 1000000; // ≈1-3MB on disk depending on encoding

// Persisting history rewrites the ENTIRE electron-store file (~1MB with a large history)
// synchronously via JSON.stringify + write. Doing that on every clipboard copy (the 1s
// watcher) blocks the main process needlessly, so writes trail behind by half a second
// and coalesce. main.js flushes on quit and on suspend/lock, so a crash risks at most
// the newest entry — the clipboard itself always keeps the actual data.
let saveTimer = null;
function saveHistorySoon() {
    if (saveTimer) return; // a write is already scheduled; it will pick up this change too
    saveTimer = setTimeout(() => {
        saveTimer = null;
        store.set('history', state.history);
    }, 500);
}

function flushHistorySave() {
    if (!saveTimer) return; // nothing pending — disk already matches memory
    clearTimeout(saveTimer);
    saveTimer = null;
    store.set('history', state.history);
}

// Broadcast updated data to windows that can actually show it. Hidden windows are
// skipped — each one re-pulls on show (quick-paste reloads via getHistory on every
// open; showMain pushes a fresh snapshot) — so pushing ~0.5MB of history over IPC to
// three windows on every clipboard copy was pure waste.
function broadcast() {
    const data = { history: state.history, favorites: state.favorites };
    [state.mainWindow, state.widgetWindow, state.quickPasteWindow].forEach(win => {
        if (win && !win.isDestroyed() && win.isVisible()) {
            win.webContents.send('update-history', data);
        }
    });
}

function addHistory(content) {
    if (!content) return;
    if (content.length > MAX_ITEM_CHARS) return; // whole-or-nothing: see MAX_ITEM_CHARS
    const existingIndex = state.history.findIndex(i => i.content === content);
    // Preserve an existing note when the same content is re-copied (dedup recreates the entry).
    const prevNote = existingIndex !== -1 ? state.history[existingIndex].note : undefined;
    if (existingIndex !== -1) state.history.splice(existingIndex, 1);

    const entry = {
        id: crypto.randomUUID(),
        content,
        timestamp: new Date().toISOString()
    };
    if (prevNote) entry.note = prevNote;
    state.history.unshift(entry);

    while (state.history.length > state.maxItems) state.history.pop();
    saveHistorySoon();
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
    broadcast();
}

function reorderFavorites(newFavorites) {
    state.favorites = newFavorites;
    store.set('favorites', state.favorites);
    broadcast();
}

// Password managers / private-mode browsers mark sensitive clipboard content with
// sentinel formats so it stays out of clipboard history — Windows and macOS each
// have their own convention (macOS: the nspasteboard.org de-facto standard;
// Transient covers "will be overwritten shortly" data like autofill staging).
// Detect via clipboard.has() (NOT availableFormats, which never lists these).
// Fails safe: on any error we return false and capture as normal, so an
// unsupported build simply loses the extra protection rather than breaking capture.
function isConcealedClipboard(clipboard) {
    try {
        if (process.platform === 'win32') {
            return clipboard.has('Clipboard Viewer Ignore')
                || clipboard.has('ExcludeClipboardContentFromMonitorProcessing')
                || clipboard.has('CanIncludeInClipboardHistory');
        }
        if (process.platform === 'darwin') {
            return clipboard.has('org.nspasteboard.ConcealedType')
                || clipboard.has('org.nspasteboard.TransientType');
        }
        return false;
    } catch (e) {
        return false;
    }
}

function startClipboardWatcher(clipboard) {
    const clipboardInterval = setInterval(() => {
        // Skip password-manager / concealed entries entirely — checked BEFORE reading text.
        if (isConcealedClipboard(clipboard)) return;
        const t = clipboard.readText();
        if (t && t !== state.lastText) {
            state.lastText = t;
            // Incognito/paused: track lastText (so the entry isn't captured on resume)
            // but do NOT persist it to history.
            if (!state.clipboardPaused) addHistory(t);
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
    startClipboardWatcher,
    broadcast,
    flushHistorySave
};
