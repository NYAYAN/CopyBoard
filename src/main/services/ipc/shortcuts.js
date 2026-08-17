const { ipcMain, globalShortcut } = require('electron');
const { state, store } = require('../state');
const { showMain, showToast, toggleQuickPaste } = require('../window-manager');
const { startCapture } = require('../capture-service');
const nativeHotkey = require('../native-hotkey');

// Defaults mirror state.js — used to recover a binding whose persisted value can
// never work as a global accelerator (see sanitizePersistedShortcuts).
const DEFAULTS = { list: 'Alt+V', draw: 'Alt+9', video: 'Alt+8', ocr: 'Alt+2', color: 'Alt+3', paste: 'CommandOrControl+Shift+V' };
const STORE_KEYS = { list: 'globalShortcut', draw: 'globalShortcutImage', video: 'globalShortcutVideo', ocr: 'globalShortcutOcr', color: 'globalShortcutColor', paste: 'globalShortcutPaste' };

// Keys that are the OS/app universal editing shortcuts. Bound as a GLOBAL
// accelerator with ONLY Cmd/Ctrl, these are worse than useless: the focused app
// consumes the keystroke (Edit ▸ Copy etc.) before our handler ever runs, so the
// callback never fires — and if the OS did hand it over, we'd hijack Copy/Cut/
// Paste/Select-All/Undo everywhere, including inside CopyBoard itself. macOS Cmd+C
// is the canonical trap a user reaches for as a "screenshot" hotkey. Adding Alt or
// Shift turns it back into a fine accelerator — which is what the Alt+… defaults do.
const RESERVED_KEYS = ['C', 'V', 'X', 'A', 'Z'];
const CMD_CTRL_MODS = ['commandorcontrol', 'cmdorctrl', 'command', 'cmd', 'control', 'ctrl', 'super', 'meta'];

// Live registrations (accelerator → handler) so they can be dropped and restored while a
// native menu is open. A macOS NSMenu runs a MODAL event-tracking loop: the main process
// stops servicing globalShortcut callbacks for as long as it's up, so every hotkey pressed
// meanwhile is QUEUED and then fires all at once the moment the menu closes — the user
// sees nothing happen, then a burst of screenshots/OCR/recordings. Unregistering makes
// such a press a genuine no-op instead.
const liveShortcuts = new Map();
let shortcutsSuspended = false;
let resumeWatchdog = null;

// ── One front door for claiming a hotkey ──────────────────────────────────────
// Almost every binding goes to Electron. A handful of physical keys have no
// accelerator name at all — most visibly the ISO key below Esc, which prints " on
// Turkish-Q — and those are recorded as their KeyboardEvent.code
// ("CommandOrControl+IntlBackslash") and claimed through the native addon instead.
// Routing on the string keeps the two apart: handing such a string to Electron would
// NOT fail, it would silently bind a different physical key.
function claim(accel, action) {
    if (nativeHotkey.isNative(accel)) return nativeHotkey.register(accel, action);
    try { return globalShortcut.register(accel, action); } catch (e) { return false; }
}

function release(accel) {
    if (!accel) return;
    if (nativeHotkey.isNative(accel)) { nativeHotkey.unregister(accel); return; }
    try { globalShortcut.unregister(accel); } catch (e) { }
}

// Native-only bindings have no accelerator string a menu can display; Electron throws
// on them. The tray shows those items without a key hint rather than not at all.
function menuAccelerator(accel) {
    return accel && !nativeHotkey.isNative(accel) ? accel : undefined;
}

function suspendShortcuts() {
    if (shortcutsSuspended) return;
    shortcutsSuspended = true;
    for (const accel of liveShortcuts.keys()) release(accel);
    // Never leave the app hotkey-less if the menu's close event goes missing.
    clearTimeout(resumeWatchdog);
    resumeWatchdog = setTimeout(resumeShortcuts, 60000);
}

function resumeShortcuts() {
    if (!shortcutsSuspended) return;
    shortcutsSuspended = false;
    clearTimeout(resumeWatchdog);
    resumeWatchdog = null;
    for (const [accel, action] of liveShortcuts) claim(accel, action);
}

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

// Keycaps for the physical keys recorded by KeyboardEvent.code. What these keys print
// depends on the layout (IntlBackslash is " on Turkish-Q, § on US-ISO); the settings
// dialog shows the real keycap because the renderer reads it off the event. Here — in
// toasts and the tray — the common case is the honest choice over "IntlBackslash".
const CODE_KEYCAPS = { IntlBackslash: '"', IntlYen: '¥', IntlRo: '_', Lang1: 'かな', Lang2: '英数' };

// Turn an Electron accelerator into something a user recognizes in a toast.
function toDisplay(accel) {
    const isMac = process.platform === 'darwin';
    return String(accel)
        .split('+')
        .map(p => {
            const raw = p.trim();
            const t = raw.toLowerCase();
            if (t === 'commandorcontrol' || t === 'cmdorctrl') return isMac ? 'Cmd' : 'Ctrl';
            if (t === 'command' || t === 'cmd' || t === 'super' || t === 'meta') return 'Cmd';
            if (t === 'control' || t === 'ctrl') return 'Ctrl';
            if (t === 'option') return 'Option';
            return CODE_KEYCAPS[raw] || raw;
        })
        .join(' + ');
}

const isEnabled = (key) => state.shortcuts.enabled[key] !== false;

function registerShortcutHandlers() {
    const actionFor = (k) => {
        if (k === 'list') return showMain;
        if (k === 'draw') return () => startCapture('draw');
        if (k === 'video') return () => startCapture('video');
        if (k === 'ocr') return () => startCapture('ocr');
        if (k === 'color') return () => startCapture('color');
        if (k === 'scroll') return () => startCapture('scroll');
        if (k === 'paste') return toggleQuickPaste;
        return null;
    };

    // Turning a shortcut off frees the accelerator for other apps without losing it here;
    // turning it back on re-registers the same binding.
    function setShortcutEnabled(key, enabled) {
        const action = actionFor(key);
        const accel = state.shortcuts[key];
        if (!action || !accel) return;

        state.shortcuts.enabled[key] = !!enabled;
        store.set('shortcutsEnabled', state.shortcuts.enabled);

        if (enabled) {
            if (!tryRegister(accel, action, key)) {
                state.shortcuts.enabled[key] = false;
                store.set('shortcutsEnabled', state.shortcuts.enabled);
                showToast(`"${toDisplay(accel)}" kaydedilemedi — başka bir uygulama kullanıyor olabilir.`, 'error');
            }
        } else {
            release(accel);
            liveShortcuts.delete(accel); // keep suspend/resume from resurrecting it
        }
        // The tray menu only advertises (and honours, while open) shortcuts that are on.
        try { require('../tray-manager').rebuildTrayMenu(); } catch (e) { console.error('rebuildTrayMenu failed:', e); }
    }

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
        const action = actionFor(key);
        if (!action) return;

        // Free the previous accelerator before claiming the new one.
        release(prevShortcut);

        // A switched-off shortcut is only stored, never registered.
        if (!isEnabled(key)) {
            state.shortcuts[key] = shortcut;
            store.set(storeKey, shortcut);
            liveShortcuts.delete(prevShortcut);
            try { require('../tray-manager').rebuildTrayMenu(); } catch (e) { console.error('rebuildTrayMenu failed:', e); }
            return;
        }

        const ok = claim(shortcut, action);

        if (ok) {
            state.shortcuts[key] = shortcut;
            store.set(storeKey, shortcut);
            liveShortcuts.delete(prevShortcut);
            liveShortcuts.set(shortcut, action); // keep suspend/resume in sync
            // The tray menu shows these as accelerators AND relies on them to work while
            // it's open, so it has to follow the new binding.
            try { require('../tray-manager').rebuildTrayMenu(); } catch (e) { console.error('rebuildTrayMenu failed:', e); }
        } else {
            // Claiming fails (without throwing) when the accelerator is already taken by
            // the OS or another app — or, for a native-only key, when the addon isn't
            // there to claim it. Don't persist a dead shortcut: say why and restore the
            // previous working binding.
            showToast(
                nativeHotkey.isNative(shortcut) && !nativeHotkey.isAvailable()
                    ? `Bu tuş bu sürümde kısayol olarak kullanılamıyor (${nativeHotkey.unavailableReason()}).`
                    : t('Kısayol kaydedilemedi - başka bir uygulama kullanıyor olabilir'),
                'error'
            );
            if (prevShortcut) claim(prevShortcut, action);
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
        const ok = claim(accel, action);
        if (ok) {
            liveShortcuts.set(accel, action); // so suspend/resume can restore it verbatim
        } else {
            console.warn(`[shortcut] "${accel}" (${label}) could not be registered — likely claimed by another app or reserved by the OS`);
        }
        return ok;
    }

    // Initial Registration
    const resetFrom = sanitizePersistedShortcuts();
    const { list, draw, video, ocr, color, scroll, paste } = state.shortcuts;
    // Only switched-on shortcuts are claimed from the OS.
    if (isEnabled('list')) tryRegister(list, showMain, 'list');
    if (isEnabled('draw')) tryRegister(draw, () => startCapture('draw'), 'draw');
    if (isEnabled('video')) tryRegister(video, () => startCapture('video'), 'video');
    if (isEnabled('ocr')) tryRegister(ocr, () => startCapture('ocr'), 'ocr');
    if (isEnabled('color')) tryRegister(color, () => startCapture('color'), 'color');
    if (isEnabled('scroll')) tryRegister(scroll, () => startCapture('scroll'), 'scroll');
    const pasteOk = !isEnabled('paste') || tryRegister(paste, toggleQuickPaste, 'paste');

    // initTray() runs BEFORE this, so a binding sanitizePersistedShortcuts() just reset
    // would leave a stale accelerator on the menu — rebuild it against the final state.
    try { require('../tray-manager').rebuildTrayMenu(); } catch (e) { console.error('rebuildTrayMenu failed:', e); }

    // Deferred, one-shot startup feedback (a toast needs a beat after launch to be seen).
    // Without this, a claimed Quick-Paste hotkey is the silent "it just doesn't open on
    // some computers" mystery — the Tray ▸ Hızlı Yapıştır entry is the always-available
    // fallback either way.
    if (paste && isEnabled('paste') && !pasteOk) {
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
    ipcMain.on('set-color-shortcut', (e, s) => updateShortcut('color', s, 'globalShortcutColor'));
    ipcMain.on('set-scroll-shortcut', (e, s) => updateShortcut('scroll', s, 'globalShortcutScroll'));
    ipcMain.on('set-shortcut-enabled', (e, key, enabled) => setShortcutEnabled(key, enabled));
    ipcMain.on('set-paste-shortcut', (e, s) => updateShortcut('paste', s, 'globalShortcutPaste'));
}

module.exports = { registerShortcutHandlers, suspendShortcuts, resumeShortcuts, menuAccelerator };
