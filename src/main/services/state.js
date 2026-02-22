const Store = require('electron-store');
const store = new Store();
const crypto = require('crypto');

// Initial Data Load
// Load & sanitize history
let savedHistory = store.get('history', []);
let hasChanges = false;

savedHistory = savedHistory.map(item => {
    if (typeof item === 'string') {
        hasChanges = true;
        return { id: crypto.randomUUID(), content: item, timestamp: new Date().toISOString() };
    }
    if (!item.id) { hasChanges = true; item.id = crypto.randomUUID(); }
    return item;
});
if (hasChanges) store.set('history', savedHistory);

// Load favorites (separate independent store)
// Migration: if history items have isFavorite:true, move them into favorites
let savedFavorites = store.get('favorites', null);
if (savedFavorites === null) {
    // First run: migrate from isFavorite flags
    savedFavorites = savedHistory
        .filter(i => i.isFavorite)
        .map(i => ({ id: crypto.randomUUID(), content: i.content, timestamp: i.timestamp || new Date().toISOString() }));
    store.set('favorites', savedFavorites);
    // Clean isFavorite flag from history
    savedHistory = savedHistory.map(i => { const { isFavorite, hiddenFromHistory, ...rest } = i; return rest; });
    store.set('history', savedHistory);
}

const state = {
    mainWindow: null,
    snipperWindow: null,
    ocrWindow: null,
    recorderWindow: null,
    widgetWindow: null,
    tray: null,
    toastWindow: null,
    history: savedHistory,
    favorites: savedFavorites,
    maxItems: store.get('maxItems', 50),
    autoStart: store.get('autoStart', true),
    videoQuality: store.get('videoQuality', 'high'),
    shortcuts: {
        list: store.get('globalShortcut', 'Alt+V'),
        draw: store.get('globalShortcutImage', 'Alt+9'),
        video: store.get('globalShortcutVideo', 'Alt+8'),
        ocr: store.get('globalShortcutOcr', 'Alt+2')
    },
    showWidget: store.get('showWidget', false),
    lastText: '',
    lastMode: 'draw',
    tempVideoPath: null,
    isCapturing: false,
    manualUpdateCheck: false
};

module.exports = {
    state,
    store
};
