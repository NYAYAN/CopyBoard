const { ipcMain, BrowserWindow, nativeTheme } = require('electron');
const { store } = require('./state');

// Interface theme. Dark is the default and the palette every stylesheet was written
// against; light re-points the same CSS tokens (see the :root blocks), so no rule needs
// to know which theme is active.
//
// Unlike the language, a theme change does NOT reload anything: each window just gets a
// message and flips data-theme on <html>. That keeps the switch instant and, more
// importantly, harmless mid-task — the snipper overlay and the recorder are windows you
// really don't want reloading under you.

const SUPPORTED = ['dark', 'light'];
let current = null;

function getTheme() {
    if (!current) {
        const saved = store.get('theme');
        current = SUPPORTED.includes(saved) ? saved : 'dark';
    }
    return current;
}

function setTheme(theme) {
    if (!SUPPORTED.includes(theme) || theme === getTheme()) return;
    current = theme;
    store.set('theme', theme);

    // Keeps native chrome (scrollbars, form controls, the colour picker) in step with
    // the page, which CSS tokens can't reach.
    nativeTheme.themeSource = theme;

    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('theme-changed', theme);
    }
}

function registerThemeHandlers() {
    nativeTheme.themeSource = getTheme();
    // Synchronous like the dictionary: the page must know its theme before it paints,
    // or every window would flash dark on the way to light.
    ipcMain.on('theme-get', (e) => { e.returnValue = getTheme(); });
    ipcMain.on('set-theme', (e, theme) => setTheme(theme));
}

module.exports = { getTheme, setTheme, registerThemeHandlers, SUPPORTED };
