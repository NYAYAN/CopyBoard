const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
// Keyboard event → Electron accelerator translation for the settings dialog.
//
// Deliberately free of DOM/Electron imports so it can be unit-tested in plain Node
// (test/accelerator.test.mjs). events.js owns the input element and only feeds events
// in and renders the result out.
//
// WHY THIS READS e.code AND NOT e.key
// -----------------------------------
// These become GLOBAL accelerators, and a global hotkey is matched against a physical
// key, not against the character the key prints. On macOS Electron registers through
// Carbon with a US-layout virtual keycode; Windows and Linux behave the same way.
// So the accelerator has to name the key by its US-layout identity — which is exactly
// what e.code reports — or it fires on the wrong key.
//
// Recording e.key instead looks right in the dialog and then silently misfires. On a
// Turkish-Q Mac the " key is the one BELOW Esc, left of 1 — on Apple's ISO keyboards
// that position is kVK_ISO_Section, which Chromium reports as e.code IntlBackslash
// (the grave/Backquote position is the key beside left Shift there, printing <>).
// Electron meanwhile resolves the accelerator "\"" back to the US quote position — the
// key that prints i/İ on that layout. The binding registers successfully and never
// responds to the key the user pressed.

// e.code → Electron accelerator key name. Returns null for keys Electron can't
// register, so the UI can say so instead of sending an invalid accelerator that
// fails with a misleading "another app owns it" toast (e.g. ArrowUp must be "Up",
// Comma must be ",").
export const CODE_TO_ACCELERATOR = {
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter',
    Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';',
    Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`',
    Minus: '-', Equal: '=',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
};

// Physical keys Electron has no accelerator name for. On macOS these are claimed
// through the native addon (native/mac-hotkey) instead, by their e.code — so the
// recorder emits the CODE itself as the key part ("CommandOrControl+IntlBackslash").
// The main process routes on exactly this: see ipc/shortcuts.js claim().
export const NATIVE_ONLY_CODES = ['IntlBackslash', 'IntlYen', 'IntlRo', 'Lang1', 'Lang2'];

// A stored binding reads back as its code ("CommandOrControl+IntlBackslash"), which is
// meaningless on screen. What the key prints depends on the layout, so these are only
// the common-case fallbacks — applyLayoutMap() replaces them with the truth for the
// keyboard actually attached.
const KEYCAPS = { IntlBackslash: '"', IntlYen: '¥', IntlRo: '_', Lang1: 'かな', Lang2: '英数' };

export function keycapFor(code) {
    return KEYCAPS[code] || code;
}

// Chromium hands out the active layout's code → character map. Cheap, exact, and the
// only way to label these keys correctly on a keyboard we haven't seen.
export function applyLayoutMap(map) {
    if (!map) return;
    for (const code of NATIVE_ONLY_CODES) {
        const cap = map.get ? map.get(code) : map[code];
        if (cap && cap.length <= 2) KEYCAPS[code] = cap;
    }
}

// Pressing only a modifier isn't a binding yet — keep waiting for the real key.
const MODIFIER_CODES = [
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'
];

// Keys that are the OS/app universal editing shortcuts. Mirrored in the main process
// (ipc/shortcuts.js RESERVED_KEYS), which enforces the same rule; this copy exists to
// give instant feedback in the dialog.
const RESERVED_KEYS = ['C', 'V', 'X', 'A', 'Z'];

// Electron only understands ASCII accelerators — globalShortcut.register() throws on
// "Alt+ş". e.code never yields one, but the guard keeps a bad binding from reaching
// the main process if that ever changes.
export const isAsciiKey = (k) => /^[\x20-\x7E]+$/.test(k);

export function acceleratorKeyFromEvent(e) {
    const code = e.code;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    return CODE_TO_ACCELERATOR[code] || null;
}

// The character printed on the pressed key, when there is one — used only to make the
// "this key can't be bound" hint name a key the user recognises. e.key is the alternate
// glyph while Alt/Option is held (macOS Option+V is "√"), so it is not worth showing then.
function keycapHint(e) {
    const ch = e.altKey ? null : e.key;
    return ch && ch.length === 1 && ch !== ' ' ? ` (${ch})` : '';
}

// Turn a keydown into a binding decision. Returns exactly one of:
//   { ignore: true }              — not a binding yet (Escape, bare modifier)
//   { error: '<hint>' }           — unusable; show the hint, keep the previous binding
//   { accelerator, display }      — accept: send `accelerator`, show `display`
export function acceleratorFromEvent(e, isMac) {
    if (e.key === 'Escape') return { ignore: true };
    if (MODIFIER_CODES.includes(e.code)) return { ignore: true };

    const keys = [];
    if (isMac) {
        if (e.metaKey) keys.push('CommandOrControl');
        if (e.ctrlKey) keys.push('Ctrl');
    } else {
        if (e.ctrlKey) keys.push('CommandOrControl');
    }
    if (e.altKey) keys.push('Alt');
    if (e.shiftKey) keys.push('Shift');

    // On macOS the keys Electron can't name are still bindable — the native addon takes
    // them by physical keycode. Record the code and let the main process route it.
    const nativeOnly = isMac && NATIVE_ONLY_CODES.includes(e.code);
    const key = nativeOnly ? e.code : acceleratorKeyFromEvent(e);
    // Anything left over has no name AND no native path (Windows/Linux, or an exotic
    // key): say so rather than binding something else.
    if (!key) return { error: `Bu tuş${keycapHint(e)} kısayol olarak kullanılamaz` };
    if (!isAsciiKey(key)) return { error: `Bu tuş${keycapHint(e)} kısayol olarak kullanılamaz` };

    // A modifier-less global accelerator would hijack plain typing everywhere
    // (binding bare "A" steals the letter A from every app). Function keys are
    // the standard standalone exception.
    const isFKey = /^F([1-9]|1\d|2[0-4])$/.test(key);
    if (keys.length === 0 && !isFKey) return { error: t('Ctrl, Alt veya Shift ile birlikte kullanın') };

    // A lone Cmd/Ctrl + a clipboard/editing key (Cmd+C, Ctrl+V, …) can't work as a
    // GLOBAL shortcut: the focused app consumes the keystroke, and binding it would
    // hijack system Copy/Cut/Paste. Reject inline and hint that Alt/Shift fixes it.
    const hasCmdCtrl = keys.some(k => k === 'CommandOrControl' || k === 'Ctrl' || k === 'Control');
    if (hasCmdCtrl && !keys.includes('Alt') && !keys.includes('Shift') && RESERVED_KEYS.includes(key)) {
        return { error: 'Alt veya Shift ekleyin' };
    }

    keys.push(key);

    // "IntlBackslash" means nothing to a user — show the character the key prints. (Not
    // while Alt is held: macOS rewrites e.key to the alternate glyph there.)
    const keyLabel = nativeOnly && !e.altKey && e.key && e.key.length === 1 ? e.key : key;

    const display = keys.map(k => {
        if (k === 'CommandOrControl') return isMac ? 'Cmd' : 'Ctrl';
        if (k === 'Control') return 'Ctrl';
        if (k === 'Option') return 'Option';
        return k === key ? keyLabel : k;
    }).join(' + ');

    return { accelerator: keys.join('+'), display };
}
