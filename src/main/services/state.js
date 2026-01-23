const Store = require('electron-store');
const store = new Store();
const crypto = require('crypto');

// Initial Data Load
let savedHistory = store.get('history', []);
let hasChanges = false;

// Migration / Sanitization
savedHistory = savedHistory.map(item => {
    if (typeof item === 'string') {
        hasChanges = true;
        return { id: crypto.randomUUID(), content: item, timestamp: new Date().toISOString(), isFavorite: false };
    }
    if (!item.id) {
        hasChanges = true;
        item.id = crypto.randomUUID();
    }
    if (item.isFavorite === undefined) {
        hasChanges = true;
        item.isFavorite = false;
    }
    return item;
});
if (hasChanges) store.set('history', savedHistory);

const state = {
    mainWindow: null,
    snipperWindow: null,
    ocrWindow: null,
    recorderWindow: null,
    tray: null,
    toastWindow: null,
    history: savedHistory,
    maxItems: store.get('maxItems', 50),
    autoStart: store.get('autoStart', true),
    videoQuality: store.get('videoQuality', 'high'),
    shortcuts: {
        list: store.get('globalShortcut', 'Alt+V'),
        draw: store.get('globalShortcutImage', 'Alt+9'),
        video: store.get('globalShortcutVideo', 'Alt+8'),
        ocr: store.get('globalShortcutOcr', 'Alt+2')
    },
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
