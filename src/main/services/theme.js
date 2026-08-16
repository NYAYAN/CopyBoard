const { ipcMain, BrowserWindow, nativeTheme } = require('electron');
const { store } = require('./state');

// Interface theme. Dark is the palette every stylesheet was written against; light
// re-points the same CSS tokens (see the :root blocks), so no rule needs to know which
// one is active.
//
// Two different values matter here and they are deliberately kept apart:
//   MODE      what the user picked — 'dark' | 'light' | 'system'
//   RESOLVED  what a window should actually paint — 'dark' | 'light'
// Only Settings cares about the mode; every window is told the resolved value.
//
// A theme change does NOT reload anything, unlike the language: each window just gets a
// message and flips data-theme on <html>. That keeps the switch instant and harmless
// mid-task — the snipper overlay and the recorder are windows you really don't want
// reloading under you.

const SUPPORTED = ['dark', 'light', 'system'];
let mode = null;

// Dark, not 'system': the app has always been dark, and an update shouldn't repaint
// itself because of an OS setting the user never connected to CopyBoard.
function getMode() {
    if (!mode) {
        const saved = store.get('theme');
        mode = SUPPORTED.includes(saved) ? saved : 'dark';
    }
    return mode;
}

function resolved() {
    const m = getMode();
    if (m !== 'system') return m;
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function broadcast() {
    const theme = resolved();
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('theme-changed', theme);
    }
}

function setTheme(next) {
    if (!SUPPORTED.includes(next) || next === getMode()) return;
    mode = next;
    store.set('theme', next);
    // Also keeps native chrome (scrollbars, form controls, the colour picker) in step,
    // which CSS tokens can't reach — and with 'system' it is what makes
    // shouldUseDarkColors track the OS.
    nativeTheme.themeSource = next;
    broadcast();
}

function registerThemeHandlers() {
    nativeTheme.themeSource = getMode();

    // Synchronous like the dictionary: a page must know its theme before it paints, or
    // every window flashes dark on the way to light.
    ipcMain.on('theme-get', (e) => { e.returnValue = { mode: getMode(), resolved: resolved() }; });
    ipcMain.on('set-theme', (e, next) => setTheme(next));

    // The OS switched appearance (or its schedule fired) while we're following it.
    nativeTheme.on('updated', () => { if (getMode() === 'system') broadcast(); });
}

module.exports = { getMode, resolved, setTheme, registerThemeHandlers, SUPPORTED };
