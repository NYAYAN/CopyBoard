const { BrowserWindow, screen, app, dialog } = require('electron');
const path = require('path');
const { state, store } = require('./state');

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

    // Clear cache
    try { state.mainWindow.webContents.session.clearCache(); } catch (e) { }

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

    // Hide Widget during capture
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        state.widgetWindow.hide();
    }

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
    // Clear cache
    try { win.webContents.session.clearCache(); } catch (e) { }

    win.webContents.setWindowOpenHandler(() => { return { action: 'deny' }; });

    win.on('closed', () => {
        state.isCapturing = false;
        if (type === 'ocr') state.ocrWindow = null;
        else if (type === 'video') state.recorderWindow = null;
        else state.snipperWindow = null;

        // Restore Widget if enabled
        if (state.showWidget) toggleWidget(true);
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

function toggleWidget(show) {
    if (show) {
        if (!state.widgetWindow || state.widgetWindow.isDestroyed()) {
            createWidgetWindow();
        } else {
            state.widgetWindow.showInactive();
        }
    } else {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.close();
        }
    }
}

function createWidgetWindow() {
    state.widgetPos = store.get('widgetPos') || { x: screen.getPrimaryDisplay().workAreaSize.width - 80, y: 100 };

    state.widgetWindow = new BrowserWindow({
        width: 68, // width for main button + padding
        height: 68,
        x: state.widgetPos.x,
        y: state.widgetPos.y,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    state.widgetWindow.setAlwaysOnTop(true, 'screen-saver');
    state.widgetWindow.loadFile(path.join(__dirname, '../../renderer/widget/widget.html'));

    // Ignore mouse events on the transparent parts, only clickable where pixels are painted
    state.widgetWindow.setIgnoreMouseEvents(false); // Can't easily use forward on Windows with transparent without breaking drag. Wait, we usually don't need ignore for a small square
}

function handleWidgetAction(action, data) {
    if (!state.widgetWindow || state.widgetWindow.isDestroyed()) return;

    if (action === 'expand') {
        const bounds = state.widgetWindow.getBounds();
        state.widgetWindow.setBounds({
            x: bounds.x,
            y: bounds.y,
            width: 68,
            height: 300
        });
    } else if (action === 'collapse') {
        const bounds = state.widgetWindow.getBounds();
        state.widgetWindow.setBounds({
            x: bounds.x,
            y: bounds.y,
            width: 68,
            height: 68
        });
    } else if (action === 'drag') {
        // Delta from custom JS drag
        const bounds = state.widgetWindow.getBounds();
        const display = screen.getDisplayMatching(bounds);
        let newX = bounds.x + data.x;
        let newY = bounds.y + data.y;

        // Basic limits
        if (newX < display.bounds.x) newX = display.bounds.x;
        if (newX > display.bounds.x + display.bounds.width - bounds.width) newX = display.bounds.x + display.bounds.width - bounds.width;
        if (newY < display.bounds.y) newY = display.bounds.y;
        if (newY > display.bounds.y + display.bounds.height - bounds.height) newY = display.bounds.y + display.bounds.height - bounds.height;

        state.widgetWindow.setBounds({ x: newX, y: newY, width: bounds.width, height: bounds.height });
    } else if (action === 'drag-end') {
        // Snap to nearest edge
        const bounds = state.widgetWindow.getBounds();
        const display = screen.getDisplayMatching(bounds);

        const distLeft = bounds.x - display.bounds.x;
        const distRight = (display.bounds.x + display.bounds.width) - (bounds.x + bounds.width);

        let targetX = bounds.x;
        if (distLeft < distRight) {
            targetX = display.bounds.x + 10; // Snap to left with padding
        } else {
            targetX = display.bounds.x + display.bounds.width - bounds.width - 10; // Snap to right 
        }

        // Animate or just set
        state.widgetWindow.setBounds({ x: targetX, y: bounds.y, width: bounds.width, height: bounds.height });

        // Save to store
        store.set('widgetPos', { x: targetX, y: bounds.y });
        state.widgetPos = { x: targetX, y: bounds.y };

    } else if (action === 'open-list') {
        showMain();
    } else if (action === 'capture-draw') {
        require('./capture-service').startCapture('draw');
    } else if (action === 'capture-ocr') {
        require('./capture-service').startCapture('ocr');
    } else if (action === 'capture-video') {
        require('./capture-service').startCapture('video');
    }
}

module.exports = {
    showMain,
    createMainWindow,
    createCapture,
    showToast,
    toggleWidget,
    handleWidgetAction
};
