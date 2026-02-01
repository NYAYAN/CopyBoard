const { BrowserWindow, screen, app, dialog } = require('electron');
const path = require('path');
const { state } = require('./state');

function showMain() {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const { width, height } = display.workAreaSize;
        state.mainWindow.setAlwaysOnTop(true, 'screen-saver');
        state.mainWindow.setPosition(
            display.workArea.x + width - 380,
            display.workArea.y + height - 560
        );
        state.mainWindow.show();
        state.mainWindow.focus();
    }
}

function createMainWindow() {
    state.mainWindow = new BrowserWindow({
        width: 350, height: 550, frame: false, show: false, skipTaskbar: true,
        transparent: process.platform === 'darwin',
        vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
        visualEffectState: 'active',
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) require('electron').shell.openExternal(url);
        return { action: 'deny' };
    });

    state.mainWindow.loadFile(path.join(__dirname, '../../renderer/main-window/index.html'));
    state.mainWindow.on('blur', () => {
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.webContents.send('reset-view');
            state.mainWindow.hide();
        }
    });
}

function createCapture(type = 'draw', display = null) {
    if (!display) display = screen.getPrimaryDisplay();
    const win = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y,
        width: display.bounds.width, height: display.bounds.height,
        frame: false, transparent: true, alwaysOnTop: true,
        fullscreen: process.platform !== 'darwin',
        simpleFullscreen: process.platform === 'darwin',
        skipTaskbar: true, movable: false, resizable: false,
        enableLargerThanScreen: true,
        hasShadow: false,
        focusable: true,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    let file = '../renderer/snipper/snipper.html';
    if (type === 'ocr') file = '../renderer/ocr/ocr.html';
    if (type === 'video') file = '../renderer/recorder/recorder.html';

    win.loadFile(path.join(__dirname, file)); // __dirname is src/main/services, so we go up one more? No wait.
    // __dirname here is src/main/services
    // file is ../renderer...
    // path.join('src/main/services', '../renderer/snipper/snipper.html') -> src/main/renderer/snipper... WRONG
    // We need to go up to src: ../../ -> src/main -> src
    // path.join(__dirname, '../../renderer/snipper/snipper.html') would be correct.
    // The logic in main.js was path.join(__dirname, '../renderer/...') because main.js was in src/main.

    // So here inside src/main/services:
    // ../ -> src/main
    // ../../ -> src
    // ../../renderer -> src/renderer

    // Let's fix the path logic here to be safe
    const rendererPath = path.resolve(__dirname, '../../renderer');

    if (type === 'ocr') win.loadFile(path.join(rendererPath, 'ocr/ocr.html'));
    else if (type === 'video') win.loadFile(path.join(rendererPath, 'recorder/recorder.html'));
    else win.loadFile(path.join(rendererPath, 'snipper/snipper.html'));

    const level = process.platform === 'darwin' ? 'pop-up-menu' : 'screen-saver';
    win.setAlwaysOnTop(true, level);
    win.webContents.setWindowOpenHandler(() => { return { action: 'deny' }; });

    win.on('closed', () => {
        state.isCapturing = false;
        if (type === 'ocr') state.ocrWindow = null;
        else if (type === 'video') state.recorderWindow = null;
        else state.snipperWindow = null;
    });

    if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.setKiosk(false);
    }

    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') {
            win.close();
            event.preventDefault();
        }
    });

    if (type === 'ocr') state.ocrWindow = win;
    else if (type === 'video') state.recorderWindow = win;
    else state.snipperWindow = win;

    return win;
}

function showToast(message, type = 'info') {
    try {
        if (state.toastWindow && !state.toastWindow.isDestroyed()) {
            state.toastWindow.destroy();
        }
        const display = screen.getPrimaryDisplay();
        const { width } = display.workAreaSize;
        state.toastWindow = new BrowserWindow({
            width: 320, height: 100, x: width - 370, y: 50,
            frame: false, transparent: true, alwaysOnTop: true,
            skipTaskbar: true, resizable: false, show: false,
            webPreferences: {
                preload: path.join(__dirname, '../../preload/preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true
            }
        });
        state.toastWindow.setAlwaysOnTop(true, 'screen-saver');
        state.toastWindow.loadFile(path.join(__dirname, '../../renderer/toast/toast.html'));
        state.toastWindow.once('ready-to-show', () => {
            if (state.toastWindow && !state.toastWindow.isDestroyed()) {
                state.toastWindow.showInactive();
                state.toastWindow.webContents.send('display-toast', message, type);
            }
        });
        state.toastWindow.setIgnoreMouseEvents(true);
    } catch (e) { console.error('Toast Error:', e); }
}

module.exports = {
    showMain,
    createMainWindow,
    createCapture,
    showToast
};
