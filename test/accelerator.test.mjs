// Unit tests for the settings-dialog shortcut recorder.
//
// Run with:  npm test
//
// The property under test is that a recorded accelerator names the PHYSICAL key, not
// the character printed on it. Global hotkeys are matched by physical key, so reading
// e.key produces bindings that register successfully and then never fire — see the
// header comment in accelerator.js for the Turkish-Q case that this protects against.
//
// Registration itself is checked against real Electron by
// test/electron-accelerator-check.js (npm run test:electron).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The app ships as "type": "commonjs", so Node would parse this ESM source as CJS and
// choke on `export`. Loading it through a data: URL forces ESM parsing without adding
// a nested package.json to the packaged app. accelerator.js has no relative imports,
// which is what makes this exact rather than a stand-in.
const MODULE_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/renderer/main-window/modules/accelerator.js'
);
const source = await readFile(MODULE_PATH, 'utf8');
const { acceleratorFromEvent, acceleratorKeyFromEvent } =
    await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

// A KeyboardEvent stand-in — only the fields the recorder reads.
const ev = (o) => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

const MAC = true;
const WIN = false;

test('records the physical key, not the printed character', async (t) => {
    // Verified against the live layout: on Turkish-Q the 2 key prints ' when shifted,
    // and Electron resolves the accelerator "2" back to that same physical key. Reading
    // e.key here would store "'", which resolves to the US apostrophe key instead.
    await t.test('Turkish-Q Mac: Cmd + Shift + 2 (keycap shows \')', () => {
        const r = acceleratorFromEvent(ev({ key: "'", code: 'Digit2', shiftKey: true, metaKey: true }), MAC);
        assert.equal(r.accelerator, 'CommandOrControl+Shift+2');
    });

    await t.test('Turkish-Q Mac: Cmd + ö binds the Comma position', () => {
        const r = acceleratorFromEvent(ev({ key: 'ö', code: 'Comma', metaKey: true }), MAC);
        assert.equal(r.accelerator, 'CommandOrControl+,');
    });

    await t.test('Turkish-Q Mac: Cmd + ş binds the Semicolon position', () => {
        // Reading e.key would yield "ş", which globalShortcut.register() throws on.
        const r = acceleratorFromEvent(ev({ key: 'ş', code: 'Semicolon', metaKey: true }), MAC);
        assert.equal(r.accelerator, 'CommandOrControl+;');
    });

    await t.test('US Mac: Cmd + Shift + \' is unchanged', () => {
        const r = acceleratorFromEvent(ev({ key: '"', code: 'Quote', shiftKey: true, metaKey: true }), MAC);
        assert.equal(r.accelerator, "CommandOrControl+Shift+'");
    });
});

test('the ISO key below Esc goes down the native path on macOS', async (t) => {
    // The "/é key on a Turkish-Q Mac: left of 1, below Esc. Apple's ISO keyboards put
    // kVK_ISO_Section there, which Chromium reports as IntlBackslash. Electron's
    // accelerator vocabulary has no name for it — verified against Electron 39, which
    // rejects "IntlBackslash"/"OEM_102"/"§" and resolves "\"" to the US quote position
    // (the i/İ key on that layout). So it is recorded as the CODE and claimed through
    // native/mac-hotkey by raw keycode instead.
    await t.test('recorded as the physical code, displayed as the keycap', () => {
        const r = acceleratorFromEvent(ev({ key: '"', code: 'IntlBackslash', metaKey: true }), MAC);
        assert.equal(r.accelerator, 'CommandOrControl+IntlBackslash');
        assert.equal(r.display, 'Cmd + "');
    });

    await t.test('modifiers ride along', () => {
        const r = acceleratorFromEvent(ev({ key: '"', code: 'IntlBackslash', metaKey: true, shiftKey: true }), MAC);
        assert.equal(r.accelerator, 'CommandOrControl+Shift+IntlBackslash');
    });

    await t.test('still needs a modifier, like every other key', () => {
        const r = acceleratorFromEvent(ev({ key: '"', code: 'IntlBackslash' }), MAC);
        assert.equal(r.accelerator, undefined);
        assert.equal(r.error, 'Ctrl, Alt veya Shift ile birlikte kullanın');
    });

    await t.test('Windows has no native path, so it stays rejected there', () => {
        const r = acceleratorFromEvent(ev({ key: '"', code: 'IntlBackslash', ctrlKey: true }), WIN);
        assert.equal(r.accelerator, undefined);
        assert.equal(r.error, 'Bu tuş (") kısayol olarak kullanılamaz');
    });

    await t.test('Electron itself still has no name for it', () => {
        assert.equal(acceleratorKeyFromEvent(ev({ code: 'IntlBackslash' })), null);
    });
});

test('a key with neither an Electron name nor a native path is refused', () => {
    const r = acceleratorFromEvent(ev({ key: 'Unidentified', code: 'Fn', metaKey: true }), MAC);
    assert.equal(r.accelerator, undefined);
    assert.ok(r.error.startsWith('Bu tuş'));
});

test('Alt/Option bindings survive the OS rewriting e.key', async (t) => {
    // macOS turns Option+V into "√". Since the accelerator comes from e.code, the
    // shipped Alt+… defaults are unaffected either way — this pins that down.
    const cases = [
        ['Alt+V (list)', ev({ key: '√', code: 'KeyV', altKey: true }), 'Alt+V'],
        ['Alt+9 (draw)', ev({ key: 'ª', code: 'Digit9', altKey: true }), 'Alt+9'],
        ['Alt+8 (video)', ev({ key: '•', code: 'Digit8', altKey: true }), 'Alt+8'],
        ['Alt+2 (ocr)', ev({ key: '€', code: 'Digit2', altKey: true }), 'Alt+2'],
        ['Alt+3 (color)', ev({ key: '#', code: 'Digit3', altKey: true }), 'Alt+3'],
    ];
    for (const [label, e, expected] of cases) {
        await t.test(label, () => {
            assert.equal(acceleratorFromEvent(e, MAC).accelerator, expected);
        });
    }
});

test('keys that need a name rather than a glyph', async (t) => {
    const cases = [
        ['arrow key', ev({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }), 'CommandOrControl+Up'],
        ['space', ev({ key: ' ', code: 'Space', metaKey: true }), 'CommandOrControl+Space'],
        ['keypad stays "num5"', ev({ key: '5', code: 'Numpad5', metaKey: true }), 'CommandOrControl+num5'],
        ['function key needs no modifier', ev({ key: 'F5', code: 'F5' }), 'F5'],
        ['dead key still binds its position', ev({ key: 'Dead', code: 'Digit3', metaKey: true }), 'CommandOrControl+3'],
        ['Equal position is "=" , never "+"', ev({ key: '+', code: 'Equal', shiftKey: true, metaKey: true }), 'CommandOrControl+Shift+='],
    ];
    for (const [label, e, expected] of cases) {
        await t.test(label, () => {
            assert.equal(acceleratorFromEvent(e, MAC).accelerator, expected);
        });
    }
});

test('guards that keep a binding usable as a global shortcut', async (t) => {
    await t.test('a bare letter would hijack typing everywhere', () => {
        const r = acceleratorFromEvent(ev({ key: 'k', code: 'KeyK' }), MAC);
        assert.match(r.error, /Ctrl, Alt veya Shift/);
    });

    await t.test('Cmd+C collides with system Copy', () => {
        const r = acceleratorFromEvent(ev({ key: 'c', code: 'KeyC', metaKey: true }), MAC);
        assert.match(r.error, /Alt veya Shift ekleyin/);
    });

    await t.test('Cmd+Shift+C is fine — Shift lifts the collision', () => {
        const r = acceleratorFromEvent(ev({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true }), MAC);
        assert.equal(r.accelerator, 'CommandOrControl+Shift+C');
    });

    await t.test('Escape and bare modifiers are not bindings yet', () => {
        assert.equal(acceleratorFromEvent(ev({ key: 'Escape', code: 'Escape' }), MAC).ignore, true);
        assert.equal(acceleratorFromEvent(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }), MAC).ignore, true);
        assert.equal(acceleratorFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), MAC).ignore, true);
    });
});

test('modifier order and display naming', async (t) => {
    await t.test('Mac Cmd+Ctrl+Alt+Shift+K', () => {
        const e = ev({ key: 'k', code: 'KeyK', metaKey: true, ctrlKey: true, altKey: true, shiftKey: true });
        const r = acceleratorFromEvent(e, MAC);
        assert.equal(r.accelerator, 'CommandOrControl+Ctrl+Alt+Shift+K');
        assert.equal(r.display, 'Cmd + Ctrl + Alt + Shift + K');
    });

    await t.test('Windows Ctrl maps to CommandOrControl and displays as Ctrl', () => {
        const r = acceleratorFromEvent(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), WIN);
        assert.equal(r.accelerator, 'CommandOrControl+K');
        assert.equal(r.display, 'Ctrl + K');
    });

    await t.test('the display matches what is stored, so it survives a reload', () => {
        // The dialog repopulates from the stored accelerator on load; a keycap-based
        // display would disagree with itself after restarting the app.
        const r = acceleratorFromEvent(ev({ key: 'ö', code: 'Comma', metaKey: true }), MAC);
        assert.equal(r.display, 'Cmd + ,');
        assert.equal(r.accelerator, 'CommandOrControl+,');
    });
});
