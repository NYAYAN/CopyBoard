'use strict';

// JS face of the macOS raw-keycode hotkey addon. Speaks the same accelerator shape as
// Electron ("CommandOrControl+Shift+X"), except the key part is a KeyboardEvent.code —
// which is the whole point: those are the keys Electron has no name for.
//
// Loading is lazy and failure is soft: if the binary isn't built (non-macOS, or an
// install without a compiler), isAvailable() is false and callers fall back to
// Electron's globalShortcut. Nothing here throws at require time.

const path = require('path');

// The physical keys Electron's accelerator vocabulary can't express, and their macOS
// virtual keycodes. Everything else Electron handles perfectly well and should keep
// going through globalShortcut — this addon is the exception path, not a replacement.
const CODE_TO_KEYCODE = {
    IntlBackslash: 0x0A, // kVK_ISO_Section — below Esc on ISO keyboards ("/é on Turkish-Q)
    IntlYen: 0x5D,       // kVK_JIS_Yen
    IntlRo: 0x5E,        // kVK_JIS_Underscore
    Lang1: 0x68,         // kVK_JIS_Kana
    Lang2: 0x66          // kVK_JIS_Eisu
};

const CMD = ['commandorcontrol', 'cmdorctrl', 'command', 'cmd', 'meta', 'super'];
const CTRL = ['control', 'ctrl'];
const ALT = ['alt', 'option'];

let native = null;
let loadError = null;
let started = false;
let nextId = 1;

const byId = new Map();       // id -> { accelerator, callback }
const byAccelerator = new Map(); // accelerator -> id

function load() {
    if (native || loadError) return native;
    if (process.platform !== 'darwin') {
        loadError = new Error('macOS only');
        return null;
    }
    try {
        native = require(path.join(__dirname, 'build', 'Release', 'mac_hotkey.node'));
    } catch (err) {
        loadError = err;
        native = null;
    }
    return native;
}

// Split "CommandOrControl+Shift+IntlBackslash" into a keycode + modifier flags.
// Returns null when the key part isn't one of ours, which is how callers decide
// whether an accelerator belongs to this path at all.
function parse(accelerator) {
    const parts = String(accelerator || '').split('+').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null; // a modifier-less global hotkey is never wanted here

    const keyCode = CODE_TO_KEYCODE[parts[parts.length - 1]];
    if (keyCode === undefined) return null;

    const mods = parts.slice(0, -1).map(p => p.toLowerCase());
    const flags = {
        cmd: mods.some(m => CMD.includes(m)),
        shift: mods.includes('shift'),
        alt: mods.some(m => ALT.includes(m)),
        ctrl: mods.some(m => CTRL.includes(m))
    };
    if (!flags.cmd && !flags.shift && !flags.alt && !flags.ctrl) return null;
    return { keyCode, flags };
}

// True when this accelerator names a key only this addon can reach.
function canHandle(accelerator) {
    return parse(accelerator) !== null;
}

function isAvailable() {
    return !!load();
}

function ensureStarted() {
    if (started) return true;
    const mod = load();
    if (!mod) return false;
    started = mod.start((id) => {
        const entry = byId.get(id);
        if (entry) {
            try { entry.callback(); } catch (err) { console.error('[mac-hotkey] handler failed:', err); }
        }
    });
    return started;
}

function register(accelerator, callback) {
    const parsed = parse(accelerator);
    if (!parsed || typeof callback !== 'function') return false;
    if (!ensureStarted()) return false;
    if (byAccelerator.has(accelerator)) unregister(accelerator); // re-binding replaces

    const id = nextId++;
    const { keyCode, flags } = parsed;
    const ok = native.registerHotKey(id, keyCode, flags.cmd, flags.shift, flags.alt, flags.ctrl);
    if (!ok) return false; // taken by another app, or the OS refused it

    byId.set(id, { accelerator, callback });
    byAccelerator.set(accelerator, id);
    return true;
}

function unregister(accelerator) {
    const id = byAccelerator.get(accelerator);
    if (id === undefined || !native) return false;
    native.unregisterHotKey(id);
    byAccelerator.delete(accelerator);
    byId.delete(id);
    return true;
}

function unregisterAll() {
    if (!native) return;
    native.unregisterAll();
    byId.clear();
    byAccelerator.clear();
}

const isRegistered = (accelerator) => byAccelerator.has(accelerator);

module.exports = {
    CODE_TO_KEYCODE, canHandle, isAvailable, isRegistered,
    register, unregister, unregisterAll,
    get loadError() { return loadError; }
};
