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
} else {
    // Backfill ids on any legacy favorites that lack one (drag-reorder and remove key off id).
    let favChanged = false;
    savedFavorites = savedFavorites.map(item => {
        if (typeof item === 'string') { favChanged = true; return { id: crypto.randomUUID(), content: item, timestamp: new Date().toISOString() }; }
        if (!item.id) { favChanged = true; item.id = crypto.randomUUID(); }
        return item;
    });
    if (favChanged) store.set('favorites', savedFavorites);
}

const state = {
    mainWindow: null,
    snipperWindow: null,
    ocrWindow: null,
    recorderWindow: null,
    scrollerWindow: null,
    captureWindows: [], // all active capture overlay windows (one per monitor)
    widgetWindow: null,
    quickPasteWindow: null,
    tray: null,
    toastWindow: null,
    history: savedHistory,
    favorites: savedFavorites,
    maxItems: store.get('maxItems', 50),
    quickPasteCount: store.get('quickPasteCount', 20),
    autoStart: store.get('autoStart', true),
    clipboardPaused: store.get('clipboardPaused', false),
    videoQuality: store.get('videoQuality', 'high'),
    audioMic: store.get('audioMic', false),
    audioSystem: store.get('audioSystem', false),
    shortcuts: {
        list: store.get('globalShortcut', 'Alt+V'),
        draw: store.get('globalShortcutImage', 'Alt+9'),
        video: store.get('globalShortcutVideo', 'Alt+8'),
        ocr: store.get('globalShortcutOcr', 'Alt+2'),
        color: store.get('globalShortcutColor', 'Alt+3'),
        scroll: store.get('globalShortcutScroll', 'Alt+4'),
        // Per-shortcut on/off. The accelerator is KEPT when a shortcut is switched off, so
        // turning it back on restores the same binding — only the registration goes away.
        enabled: Object.assign(
            { list: true, draw: true, video: true, ocr: true, color: true, scroll: true, paste: true },
            store.get('shortcutsEnabled', {})
        ),
        paste: store.get('globalShortcutPaste', 'CommandOrControl+Shift+V')
    },
    showWidget: store.get('showWidget', false),
    widgetTransparent: store.get('widgetTransparent', false),
    widgetColor: store.get('widgetColor', '#8957e5'),
    widgetOpacity: store.get('widgetOpacity', 100),
    widgetScale: store.get('widgetScale', 100),
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
