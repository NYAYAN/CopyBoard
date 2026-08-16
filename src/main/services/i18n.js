const { ipcMain, BrowserWindow } = require('electron');
const { store } = require('./state');

// Interface language. Turkish is the SOURCE language: every string in the code is
// written in Turkish and doubles as its own lookup key, so a key with no translation
// simply stays Turkish instead of showing a raw identifier. That keeps the diff for
// "make the app translatable" almost invisible in the UI code — t('Kaydet') reads the
// same as the literal it replaced — and it means an incomplete dictionary can never
// break a screen.
const DICTIONARIES = { en: require('../../shared/i18n/en.json') };
const SUPPORTED = ['tr', 'en'];

let current = null;

// Turkish, deliberately — NOT the OS locale. The app shipped Turkish-only until now, so
// following the system language would flip every existing user to English on update, and
// a Turkish speaker on an English-locale Mac is exactly the common case here. English is
// one click away in Settings; a silent switch is not something an update should do.
function detectDefault() {
    return 'tr';
}

function getLanguage() {
    if (!current) {
        const saved = store.get('language');
        current = SUPPORTED.includes(saved) ? saved : detectDefault();
    }
    return current;
}

function fill(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

// t('Kaydet') → 'Save' | t('Kopyalama Hatası: {error}', { error: e.message })
function t(turkish, vars) {
    const dict = DICTIONARIES[getLanguage()];
    return fill((dict && dict[turkish]) || turkish, vars);
}

function setLanguage(lang) {
    if (!SUPPORTED.includes(lang) || lang === getLanguage()) return;
    current = lang;
    store.set('language', lang);

    // Every window paints its own strings at load, so a reload is the whole update —
    // no per-surface re-render code to keep in sync. Window state lives in the main
    // process, so nothing is lost.
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.reload();
    }
    try { require('./tray-manager').rebuildTrayMenu(); } catch (e) { console.error('rebuildTrayMenu failed:', e); }
}

function registerI18nHandlers() {
    // Synchronous on purpose: the preload has to hand the dictionary to the page before
    // any of its scripts run, and sandboxed preloads can't read files themselves.
    ipcMain.on('i18n-get', (e) => {
        e.returnValue = { lang: getLanguage(), dict: DICTIONARIES[getLanguage()] || {} };
    });
    ipcMain.on('set-language', (e, lang) => setLanguage(lang));
}

module.exports = { t, getLanguage, setLanguage, registerI18nHandlers, SUPPORTED };
