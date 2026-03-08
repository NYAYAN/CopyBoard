const { state, store } = require('./state');
const { showToast } = require('./window-manager');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const path = require('path');

// Initialize compression worker
const workerPath = path.join(__dirname, 'compression-worker.js');
const compressionWorker = new Worker(workerPath);
const pendingRequests = new Map();

compressionWorker.on('message', (msg) => {
    const { id, success, result, error } = msg;
    if (pendingRequests.has(id)) {
        const { resolve, reject } = pendingRequests.get(id);
        pendingRequests.delete(id);
        if (success) resolve(result);
        else reject(new Error(error));
    }
});

function compressDataAsync(data) {
    if (!data) return Promise.resolve(data);
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pendingRequests.set(id, { resolve, reject });
        compressionWorker.postMessage({ id, action: 'compress', data });
    });
}

function decompressDataAsync(data) {
    if (!data) return Promise.resolve(data);
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pendingRequests.set(id, { resolve, reject });
        compressionWorker.postMessage({ id, action: 'decompress', data });
    });
}

const decompressedCache = new Map();

function decompressBatchAsync(dataArray) {
    if (!dataArray || dataArray.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pendingRequests.set(id, { resolve, reject });
        compressionWorker.postMessage({ id, action: 'decompress-batch', data: dataArray });
    });
}

async function getDecompressedList(items) {
    const toDecompress = [];

    items.forEach(item => {
        if (item.compressed && !decompressedCache.has(item.id)) {
            toDecompress.push(item);
        }
    });

    if (toDecompress.length > 0) {
        try {
            const dataArray = toDecompress.map(i => i.content);
            const results = await decompressBatchAsync(dataArray);
            toDecompress.forEach((item, index) => {
                decompressedCache.set(item.id, results[index]);
            });
        } catch (e) {
            console.error('Batch decompression failed:', e);
        }
    }

    return items.map(item => {
        if (item.compressed && decompressedCache.has(item.id)) {
            return { ...item, content: decompressedCache.get(item.id) };
        }
        return item;
    });
}

async function getDecompressedHistory() {
    return getDecompressedList(state.history);
}

async function getDecompressedFavorites() {
    return getDecompressedList(state.favorites);
}

// Broadcast updated data to all windows
async function broadcast() {
    const history = await getDecompressedHistory();
    const favorites = await getDecompressedFavorites();
    const data = { history, favorites };
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('update-history', data);
    }
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        state.widgetWindow.webContents.send('update-history', data);
    }
}

async function addHistory(content) {
    if (!content) return;
    
    const compressedData = await compressDataAsync(content);
    
    const existingIndex = state.history.findIndex(i => {
        if (i.compressed) return i.content === compressedData;
        return i.content === content;
    });
    
    if (existingIndex !== -1) state.history.splice(existingIndex, 1);

    state.history.unshift({
        id: crypto.randomUUID(),
        content: compressedData,
        compressed: true,
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

async function addToFavorites(item) {
    const compressedData = await compressDataAsync(item.content);
    
    const exists = state.favorites.some(f => 
        (f.compressed ? f.content === compressedData : f.content === item.content)
    );
    
    if (!exists) {
        state.favorites.unshift({
            id: crypto.randomUUID(),
            content: compressedData,
            compressed: true,
            timestamp: item.timestamp || new Date().toISOString(),
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

function reorderHistory(newHistoryItems) {
    const newOrderIds = newHistoryItems.map(i => i.id);
    state.history.sort((a, b) => {
        let ai = newOrderIds.indexOf(a.id);
        let bi = newOrderIds.indexOf(b.id);
        if (ai === -1) ai = 999999;
        if (bi === -1) bi = 999999;
        return ai - bi;
    });
    store.set('history', state.history);
    // broadcast() omitted intentional (reordering is usually just state update)
}

function reorderFavorites(newFavoritesItems) {
    const newOrderIds = newFavoritesItems.map(i => i.id);
    state.favorites.sort((a, b) => {
        let ai = newOrderIds.indexOf(a.id);
        let bi = newOrderIds.indexOf(b.id);
        if (ai === -1) ai = 999999;
        if (bi === -1) bi = 999999;
        return ai - bi;
    });
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
    startClipboardWatcher,
    getDecompressedHistory,
    getDecompressedFavorites
};
