const { ipcMain, globalShortcut } = require('electron');
const { state, store } = require('../state');
const { showMain, showToast, toggleQuickPaste } = require('../window-manager');
const { startCapture } = require('../capture-service');

// Defaults mirror state.js — used to recover a binding whose persisted value can
// never work as a global accelerator (see sanitizePersistedShortcuts).
const DEFAULTS = { list: 'Alt+V', draw: 'Alt+9', video: 'Alt+8', ocr: 'Alt+2', paste: 'CommandOrControl+Shift+V' };
const STORE_KEYS = { list: 'globalShortcut', draw: 'globalShortcutImage', video: 'globalShortcutVideo', ocr: 'globalShortcutOcr', paste: 'globalShortcutPaste' };

// Keys that are the OS/app universal editing shortcuts. Bound as a GLOBAL
// accelerator with ONLY Cmd/Ctrl, these are worse than useless: the focused app
// consumes the keystroke (Edit ▸ Copy etc.) before our handler ever runs, so the
// callback never fires — and if the OS did hand it over, we'd hijack Copy/Cut/
// Paste/Select-All/Undo everywhere, including inside CopyBoard itself. macOS Cmd+C
// is the canonical trap a user reaches for as a "screenshot" hotkey. Adding Alt or
// Shift turns it back into a fine accelerator — which is what the Alt+… defaults do.
const RESERVED_KEYS = ['C', 'V', 'X', 'A', 'Z'];
const CMD_CTRL_MODS = ['commandorcontrol', 'cmdorctrl', 'command', 'cmd', 'control', 'ctrl', 'super', 'meta'];

function parseAccelerator(s) {
    const parts = String(s).split('+').map(p => p.trim()).filter(Boolean);
    const key = (parts[parts.length - 1] || '').toUpperCase();
    const mods = parts.slice(0, -1).map(p => p.toLowerCase());
    return {
        key,
        hasCmdCtrl: mods.some(m => CMD_CTRL_MODS.includes(m)),
        hasAlt: mods.some(m => m === 'alt' || m === 'option'),
        hasShift: mods.includes('shift')
    };
}

function isAsciiShortcut(s) {
    return !!s && /^[\x00-\x7F]+$/.test(s);
}

// A lone Cmd/Ctrl + reserved editing key (Cmd+C, Ctrl+V, …). See RESERVED_KEYS.
function isReservedShortcut(s) {
    if (!isAsciiShortcut(s)) return false;
    const { key, hasCmdCtrl, hasAlt, hasShift } = parseAccelerator(s);
    return hasCmdCtrl && !hasAlt && !hasShift && RESERVED_KEYS.includes(key);
}

// Turn an Electron accelerator into something a user recognizes in a toast.
function toDisplay(accel) {
    const isMac = process.platform === 'darwin';
    return String(accel)
        .split('+')
        .map(p => {
            const t = p.trim().toLowerCase();
            if (t === 'commandorcontrol' || t === 'cmdorctrl') return isMac ? 'Cmd' : 'Ctrl';
            if (t === 'command' || t === 'cmd' || t === 'super' || t === 'meta') return 'Cmd';
            if (t === 'control' || t === 'ctrl') return 'Ctrl';
            if (t === 'option') return 'Option';
            return p.trim();
        })
        .join(' + ');
}

function registerShortcutHandlers() {
    function updateShortcut(key, shortcut, storeKey) {
        if (!isAsciiShortcut(shortcut)) {
            showToast('Geçersiz Kısayol - Sadece ASCII karakterler kullanın', 'error');
            return;
        }

        // Reject accelerators that collide with the system Copy/Cut/Paste keys — they
        // can't work as globals and would break core editing (this is exactly the
        // macOS "Cmd+C for screenshot" case). Steer the user to add Alt/Shift.
        if (isReservedShortcut(shortcut)) {
            const { key: k } = parseAccelerator(shortcut);
            showToast(
                `"${toDisplay(shortcut)}" sistemin Kopyala/Kes/Yapıştır tuşlarıyla çakışıyor ve genel kısayol olarak çalışmaz. Alt veya Shift ekleyin (ör. ${toDisplay('Alt+' + k)}).`,
                'error'
            );
            return;
        }

        const prevShortcut = state.shortcuts[key];
        const actionFor = (k) => {
            if (k === 'list') return showMain;
            if (k === 'draw') return () => startCapture('draw');
            if (k === 'video') return () => startCapture('video');
            if (k === 'ocr') return () => startCapture('ocr');
            if (k === 'paste') return toggleQuickPaste;
            return null;
        };
        const action = actionFor(key);
        if (!action) return;

        // Free the previous accelerator before claiming the new one.
        try { globalShortcut.unregister(prevShortcut); } catch (e) { }

        let ok = false;
        try { ok = globalShortcut.register(shortcut, action); } catch (e) { ok = false; }

        if (ok) {
            state.shortcuts[key] = shortcut;
            store.set(storeKey, shortcut);
        } else {
            // register() returns false (without throwing) when the accelerator is already
            // claimed by the OS or another app. Don't persist a dead shortcut: warn the user
            // and restore the previous working binding.
            showToast('Kısayol kaydedilemedi - başka bir uygulama kullanıyor olabilir', 'error');
            try { if (prevShortcut) globalShortcut.register(prevShortcut, action); } catch (e) { }
        }
    }

    // A shortcut persisted before the reserved-key guard existed (e.g. a user who set
    // Cmd+C for screenshots on macOS) can never register as a global accelerator. Reset
    // it to its default so both the binding AND the Settings UI recover on next launch.
    function sanitizePersistedShortcuts() {
        let resetFrom = null;
        for (const k of Object.keys(DEFAULTS)) {
            if (state.shortcuts[k] && isReservedShortcut(state.shortcuts[k])) {
                console.warn(`[shortcut] persisted "${state.shortcuts[k]}" for "${k}" collides with a system editing key — resetting to default "${DEFAULTS[k]}"`);
                if (!resetFrom) resetFrom = state.shortcuts[k];
                state.shortcuts[k] = DEFAULTS[k];
                store.set(STORE_KEYS[k], DEFAULTS[k]);
            }
        }
        return resetFrom;
    }

    // Register one accelerator, honoring register()'s boolean (it returns false WITHOUT
    // throwing when the combo is unavailable). Each call is isolated so one bad
    // accelerator can't abort the others. Returns true only when the key is now live.
    function tryRegister(accel, action, label) {
        if (!accel) return true;
        if (isReservedShortcut(accel)) {
            console.warn(`[shortcut] "${accel}" (${label}) is a reserved editing shortcut — skipping registration`);
            return false;
        }
        let ok = false;
        try { ok = globalShortcut.register(accel, action); } catch (e) { ok = false; }
        if (!ok) {
            console.warn(`[shortcut] "${accel}" (${label}) could not be registered — likely claimed by another app or reserved by the OS`);
        }
        return ok;
    }

    // Initial Registration
    const resetFrom = sanitizePersistedShortcuts();
    const { list, draw, video, ocr, paste } = state.shortcuts;
    tryRegister(list, showMain, 'list');
    tryRegister(draw, () => startCapture('draw'), 'draw');
    tryRegister(video, () => startCapture('video'), 'video');
    tryRegister(ocr, () => startCapture('ocr'), 'ocr');
    const pasteOk = tryRegister(paste, toggleQuickPaste, 'paste');

    // Deferred, one-shot startup feedback (a toast needs a beat after launch to be seen).
    // Without this, a claimed Quick-Paste hotkey is the silent "it just doesn't open on
    // some computers" mystery — the Tray ▸ Hızlı Yapıştır entry is the always-available
    // fallback either way.
    if (paste && !pasteOk) {
        setTimeout(() => showToast(
            `Hızlı Yapıştır kısayolu (${toDisplay(paste)}) kaydedilemedi — başka bir uygulama kullanıyor olabilir. Tepsi (tray) menüsünden açabilir veya Ayarlar'dan değiştirebilirsiniz.`,
            'warning'
        ), 3000);
    } else if (resetFrom) {
        setTimeout(() => showToast(
            `"${toDisplay(resetFrom)}" kısayolu sistemin Kopyala/Yapıştır tuşlarıyla çakıştığı için varsayılana döndürüldü. Ayarlar'dan Alt veya Shift içeren bir kısayol seçebilirsiniz.`,
            'warning'
        ), 3000);
    }

    ipcMain.on('set-shortcut', (e, s) => updateShortcut('list', s, 'globalShortcut'));
    ipcMain.on('set-image-shortcut', (e, s) => updateShortcut('draw', s, 'globalShortcutImage'));
    ipcMain.on('set-video-shortcut', (e, s) => updateShortcut('video', s, 'globalShortcutVideo'));
    ipcMain.on('set-ocr-shortcut', (e, s) => updateShortcut('ocr', s, 'globalShortcutOcr'));
    ipcMain.on('set-paste-shortcut', (e, s) => updateShortcut('paste', s, 'globalShortcutPaste'));
}

module.exports = { registerShortcutHandlers };
