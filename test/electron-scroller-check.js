// Integration check: the scroll-capture overlay actually loads inside Electron.
//
// Run with:  npm run test:scroller
//
// Kept out of `npm test` because it boots Electron and needs a desktop session, like
// electron-accelerator-check.js. The stitching itself is covered by stitcher.test.mjs; what
// only a real renderer can answer is whether the PAGE comes up, and three things about it
// are easy to break and invisible until someone triggers the mode by hand:
//
//   1. scroller.js is the app's only capture overlay loaded as an ES module, so its
//      `import './stitcher.js'` has to resolve over file://. A failed import is silent —
//      the page renders perfectly and simply does nothing.
//   2. Module scripts run BEFORE DOMContentLoaded, which is the opposite of every classic
//      script in this app. The toolbar tooltips must still be wired after shared/i18n.js
//      has translated the markup, or an English UI shows Turkish labels.
//   3. The capture-screen handler has to decode a PNG buffer and answer with snip-ready.
//      Until it does, the real overlay stays hidden and the capture looks like a no-op.

const { app, ipcMain, nativeImage, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// Defaults to the working tree. Point APP_ROOT at a packaged app.asar to run the same
// checks against a real build — worth doing because reason (1) above is stricter there:
// the import has to resolve INSIDE an asar archive, through Electron's file: hook, and a
// failure still looks like a page that loads and does nothing.
//   APP_ROOT=dist/mac-arm64/CopyBoard.app/Contents/Resources/app.asar npm run test:scroller
const APP_ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const RENDERER = path.join(APP_ROOT, 'src/renderer/scroller/scroller.html');
const PRELOAD = path.join(APP_ROOT, 'src/preload/preload.js');
// Test data, always read from the working tree.
const EN_DICT = path.join(__dirname, '../src/shared/i18n/en.json');
const READY_TIMEOUT_MS = 15000;

// 1x1 transparent PNG, blown up to stand in for a display grab.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const WIDTH = 800;
const HEIGHT = 600;

const problems = [];
const logs = [];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const dict = JSON.parse(fs.readFileSync(EN_DICT, 'utf8'));

    // The preload asks for these synchronously before anything else runs. Answering in
    // ENGLISH is the point: it is what makes the tooltip-ordering assertion meaningful.
    ipcMain.on('i18n-get', (e) => { e.returnValue = { lang: 'en', dict }; });
    ipcMain.on('theme-get', (e) => { e.returnValue = { mode: 'dark', resolved: 'dark' }; });
    ipcMain.on('debug-log', (e, msg) => logs.push(String(msg)));

    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    ipcMain.on('snip-ready', () => resolveReady(true));
    ipcMain.on('capture-retry', () => {
        problems.push('the renderer rejected the screenshot and asked for a re-capture');
        resolveReady(false);
    });

    const win = new BrowserWindow({
        width: WIDTH, height: HEIGHT, show: false,
        webPreferences: {
            preload: PRELOAD,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            zoomFactor: 1.0
        }
    });

    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
        if (level >= 2) problems.push(`console error: ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('preload-error', (e, file, err) => problems.push(`preload error in ${file}: ${err.message}`));
    win.webContents.on('render-process-gone', (e, details) => problems.push(`renderer gone: ${details.reason}`));

    await win.loadFile(RENDERER);

    const png = nativeImage.createFromDataURL('data:image/png;base64,' + PIXEL)
        .resize({ width: WIDTH, height: HEIGHT })
        .toPNG();
    win.webContents.send('capture-screen', png, 'scroll', 'screen:0:0', 'high', WIDTH, HEIGHT, false);

    const readyResult = await Promise.race([
        ready,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), READY_TIMEOUT_MS))
    ]);
    if (readyResult === 'timeout') problems.push(`no snip-ready within ${READY_TIMEOUT_MS}ms — the page never finished loading its screenshot`);

    const seen = await win.webContents.executeJavaScript(`(() => ({
        hasApi: !!window.api,
        ready: document.body.classList.contains('ready'),
        phase: document.body.className,
        // Non-default canvas dimensions prove scroller.js ran: an untouched canvas is 300x150.
        canvasW: document.getElementById('screen-canvas').width,
        canvasH: document.getElementById('screen-canvas').height,
        // overlay-tooltip moves title -> data-tip, and it must do so AFTER i18n has
        // swapped the markup into English.
        startTip: document.getElementById('btn-start').dataset.tip || null,
        startLabel: document.querySelector('#btn-start span').textContent,
        instruction: document.getElementById('instruction').textContent,
        buttons: ['btn-start','btn-finish','btn-copy','btn-save','btn-close']
            .filter(id => !document.getElementById(id)).length
    }))()`);

    // Drag out a selection with synthetic events and check the toolbar actually APPEARS.
    //
    // This is here because it shipped broken once: .hidden carries `display: none
    // !important`, placeToolbar() was revealing the bar with an inline `style.display =
    // 'flex'`, and an inline value cannot beat !important — so the bar stayed invisible
    // while the code reading it looked right. With no Start button and no Finish button the
    // mode was unusable and, once started, had no way out but cancelling.
    //
    // Events go to document.body rather than window so e.target is a real element (the
    // handlers call e.target.closest).
    const bar = await win.webContents.executeJavaScript(`(() => {
        const fire = (type, x, y) => document.body.dispatchEvent(
            new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
        fire('mousedown', 80, 80);
        fire('mousemove', 480, 520);
        fire('mouseup', 480, 520);

        const toolbar = document.getElementById('toolbar');
        const start = document.getElementById('btn-start');
        const box = document.getElementById('selection-box');
        return {
            selectionW: box.offsetWidth,
            selectionH: box.offsetHeight,
            toolbarDisplay: getComputedStyle(toolbar).display,
            toolbarW: toolbar.offsetWidth,
            startDisplay: getComputedStyle(start).display,
            startW: start.offsetWidth,
            // Finish belongs to the scroll phase and must stay off the bar until then.
            finishDisplay: getComputedStyle(document.getElementById('btn-finish')).display
        };
    })()`);

    const expect = (cond, message) => { if (!cond) problems.push(message); };

    expect(bar.selectionW > 300 && bar.selectionH > 400,
        `dragging out a selection produced a ${bar.selectionW}x${bar.selectionH} box`);
    expect(bar.toolbarW > 0,
        `the toolbar is ${bar.toolbarW}px wide (display: ${bar.toolbarDisplay}) after a selection — it never became visible`);
    expect(bar.startW > 0,
        `the Start button is ${bar.startW}px wide (display: ${bar.startDisplay}) — the mode cannot be started by mouse`);
    expect(bar.finishDisplay === 'none',
        `the Finish button is visible (${bar.finishDisplay}) during the select phase`);

    expect(seen.hasApi, 'window.api is missing — the preload bridge did not load');
    expect(seen.buttons === 0, 'some toolbar buttons are missing from the markup');
    expect(seen.canvasW === WIDTH && seen.canvasH === HEIGHT,
        `screen-canvas is ${seen.canvasW}x${seen.canvasH}, expected ${WIDTH}x${HEIGHT} — scroller.js did not run (a failed stitcher.js import looks exactly like this)`);
    expect(seen.ready, 'body never got the "ready" class — the screenshot was not decoded');
    expect(seen.phase.includes('phase-select'), `expected to start in the select phase, got "${seen.phase}"`);
    expect(seen.startTip === 'Start the scrolling capture',
        `Start button tooltip is "${seen.startTip}" — overlay-tooltip ran before i18n translated the markup`);
    expect(seen.startLabel === 'Start', `Start button label is "${seen.startLabel}", expected the English string`);
    expect(seen.instruction === 'Select the area to scroll and capture',
        `instruction reads "${seen.instruction}", expected the English string`);

    console.log('\nscroll-capture overlay\n');
    console.log(`  preload bridge      ${seen.hasApi ? 'ok' : 'FAIL'}`);
    console.log(`  scroller.js ran     ${seen.canvasW === WIDTH ? 'ok' : 'FAIL'}  (canvas ${seen.canvasW}x${seen.canvasH})`);
    console.log(`  screenshot decoded  ${seen.ready ? 'ok' : 'FAIL'}`);
    console.log(`  phase               ${seen.phase}`);
    console.log(`  i18n before tips    ${seen.startTip === 'Start the scrolling capture' ? 'ok' : 'FAIL'}  ("${seen.startTip}")`);
    console.log(`  selection drag      ${bar.selectionW}x${bar.selectionH}`);
    console.log(`  toolbar visible     ${bar.toolbarW > 0 ? 'ok' : 'FAIL'}  (${bar.toolbarDisplay}, ${bar.toolbarW}px)`);
    console.log(`  Start button        ${bar.startW > 0 ? 'ok' : 'FAIL'}  (${bar.startDisplay}, ${bar.startW}px)`);
    if (logs.length) console.log(`  renderer logs       ${logs.join(' | ')}`);

    if (problems.length) {
        console.log('\nproblems:');
        problems.forEach(p => console.log('  - ' + p));
    }
    console.log(problems.length ? '\nFAILED\n' : '\nall checks passed\n');
    app.exit(problems.length ? 1 : 0);
});
