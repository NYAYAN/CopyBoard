// Integration check: every accelerator the settings dialog can produce must actually
// register with Electron's globalShortcut.
//
// Run with:  npm run test:electron
//
// Kept out of `npm test` because it boots Electron and needs a desktop session. The
// pure-logic tests in accelerator.test.mjs cover the same recorder without that.
//
// This closes the loop that unit tests can't: acceleratorFromEvent() may emit a
// perfectly reasonable-looking string that globalShortcut.register() rejects or throws
// on — "Alt++" and "Alt+ş" both do.

const { app, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '../src/renderer/main-window/modules/accelerator.js');

// Same data: URL load as the unit tests — the app is "type": "commonjs", so Node would
// otherwise parse this ESM source as CJS.
async function loadRecorder() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

const ev = (o) => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

// Representative of every branch in acceleratorKeyFromEvent: typed glyph, Alt fallback,
// numpad, named key, function key, and the "+" special case.
const SCENARIOS = [
    // Turkish-Q keycaps, US-layout positions — the accelerator must follow the position.
    ['Turkish-Q  Cmd+Shift+2   (keycap \')', ev({ key: "'", code: 'Digit2', shiftKey: true, metaKey: true })],
    ['Turkish-Q  Cmd + ,       (keycap ö)', ev({ key: 'ö', code: 'Comma', metaKey: true })],
    ['Turkish-Q  Cmd + ;       (keycap ş)', ev({ key: 'ş', code: 'Semicolon', metaKey: true })],
    ['Turkish-Q  Cmd + [       (keycap ğ)', ev({ key: 'ğ', code: 'BracketLeft', metaKey: true })],
    ['Turkish-Q  Cmd + .       (keycap ç)', ev({ key: 'ç', code: 'Period', metaKey: true })],
    ['US         Cmd+Shift+\'', ev({ key: '"', code: 'Quote', shiftKey: true, metaKey: true })],
    ['Mac        Option + V', ev({ key: '√', code: 'KeyV', altKey: true })],
    ['Mac        Option + 9', ev({ key: 'ª', code: 'Digit9', altKey: true })],
    ['Mac        Option + 8', ev({ key: '•', code: 'Digit8', altKey: true })],
    ['Mac        Option + 2', ev({ key: '€', code: 'Digit2', altKey: true })],
    ['Mac        Option + 3', ev({ key: '#', code: 'Digit3', altKey: true })],
    ['Mac        Cmd+Shift+=', ev({ key: '+', code: 'Equal', shiftKey: true, metaKey: true })],
    ['Mac        Cmd + K', ev({ key: 'k', code: 'KeyK', metaKey: true })],
    ['Mac        Cmd + Up', ev({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true })],
    ['Mac        Cmd + Space', ev({ key: ' ', code: 'Space', metaKey: true })],
    ['Mac        Cmd + Numpad5', ev({ key: '5', code: 'Numpad5', metaKey: true })],
    ['           F5', ev({ key: 'F5', code: 'F5' })],
    ['Mac        Cmd+Shift+C', ev({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true })],
    ['Mac        Cmd + `', ev({ key: '`', code: 'Backquote', metaKey: true })],
    ['Mac        Cmd + /', ev({ key: '/', code: 'Slash', metaKey: true })],
];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const { acceleratorFromEvent } = await loadRecorder();
    let failures = 0;

    console.log('\nrecorder output -> globalShortcut.register()\n');
    for (const [label, e] of SCENARIOS) {
        const result = acceleratorFromEvent(e, true);
        if (!result.accelerator) {
            failures++;
            console.log(`FAIL   ${label}\n         recorder refused it: ${result.error || 'ignored'}`);
            continue;
        }

        let ok = false, threw = null;
        try {
            ok = globalShortcut.register(result.accelerator, () => { });
        } catch (err) {
            threw = err.message;
        }
        try { globalShortcut.unregister(result.accelerator); } catch (err) { /* nothing to free */ }

        if (!ok) failures++;
        const status = threw ? 'THREW' : ok ? 'ok' : 'FAIL';
        console.log(`${status.padEnd(6)} ${label}  ->  ${result.accelerator}${threw ? '\n         ' + threw : ''}`);
    }

    globalShortcut.unregisterAll();
    console.log(`\n${SCENARIOS.length - failures}/${SCENARIOS.length} registered\n`);
    app.exit(failures ? 1 : 0);
});
