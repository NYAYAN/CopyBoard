const path = require('path');

// Bridge to native/mac-hotkey — global hotkeys for the physical keys Electron's
// accelerator strings cannot name (see that folder's mac_hotkey.mm for the why).
//
// Optional by design: Windows builds have no binary, and an install without a
// compiler leaves it unbuilt. In both cases isAvailable() is false and callers fall
// back to Electron's globalShortcut, which is the behaviour that existed before.
// Nothing here throws at require time.

let addon = null;
let loadError = null;

try {
    addon = require(path.join(__dirname, '..', '..', '..', 'native', 'mac-hotkey'));
} catch (err) {
    loadError = err; // folder trimmed from the build, or a broken binary
}

// Does this accelerator name a key that ONLY the addon can reach? Pure string work —
// it must answer before (and without) the native binary loads, because the answer is
// what keeps such a string away from Electron, which would happily resolve it to a
// different physical key.
function isNative(accelerator) {
    return !!addon && addon.canHandle(accelerator);
}

function isAvailable() {
    return !!addon && addon.isAvailable();
}

function register(accelerator, action) {
    if (!isAvailable()) return false;
    try {
        return addon.register(accelerator, action);
    } catch (err) {
        console.error('[shortcut] native register failed:', err);
        return false;
    }
}

function unregister(accelerator) {
    if (!addon) return;
    try { addon.unregister(accelerator); } catch (err) { /* not registered */ }
}

function unregisterAll() {
    if (!addon) return;
    try { addon.unregisterAll(); } catch (err) { /* nothing live */ }
}

function unavailableReason() {
    if (isAvailable()) return null;
    if (process.platform !== 'darwin') return t('yalnızca macOS');
    if (loadError) return loadError.message;
    return (addon && addon.loadError && addon.loadError.message) || t('derlenmemiş');
}

module.exports = { isNative, isAvailable, register, unregister, unregisterAll, unavailableReason };
