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
    // widgetPos stores the BUTTON position. widgetSide tracks left/right.
    state.widgetPos = store.get('widgetPos') || { x: screen.getPrimaryDisplay().workAreaSize.width - 80, y: 100 };
    state.widgetSide = store.get('widgetSide') || 'right';

    const TOTAL_WIDTH = 418; // 350 panel + 68 buttons

    state.widgetWindow = new BrowserWindow({
        width: TOTAL_WIDTH,
        height: 68,
        x: state.widgetSide === 'left' ? state.widgetPos.x : state.widgetPos.x - 350,
        y: state.widgetPos.y,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    state.widgetWindow.setAlwaysOnTop(true, 'screen-saver');
    state.widgetWindow.loadFile(path.join(__dirname, '../../renderer/widget/widget.html'));

    // Notify renderer of the saved side once it has loaded
    state.widgetWindow.webContents.on('did-finish-load', () => {
        notifySide();
    });
}

function getWindowX() {
    // Right side: buttons at right edge → window.x = buttonX - 350
    // Left side:  buttons at left edge → window.x = buttonX
    return state.widgetSide === 'left'
        ? state.widgetPos.x
        : state.widgetPos.x - 350;
}

function notifySide() {
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        state.widgetWindow.webContents.send('widget-side', state.widgetSide || 'right');
    }
}

function handleWidgetAction(action, data) {
    if (!state.widgetWindow || state.widgetWindow.isDestroyed()) return;

    const winX = getWindowX();

    if (action === 'expand') {
        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: 418, height: 300 });
    } else if (action === 'expand-history') {
        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: 418, height: 400 });
    } else if (action === 'collapse-history') {
        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: 418, height: 300 });
    } else if (action === 'collapse') {
        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: 418, height: 68 });
    } else if (action === 'drag') {
        const bounds = state.widgetWindow.getBounds();
        const display = screen.getDisplayMatching(bounds);
        // Track BUTTON position directly, keep current side stable during drag.
        // (Flipping side mid-drag causes 350px window jump at the center = freeze)
        const currentSide = state.widgetSide || 'right';
        const currentBtnX = (currentSide === 'left') ? bounds.x : bounds.x + 350;

        let newBtnX = currentBtnX + data.x;
        let newY = bounds.y + data.y;

        // Clamp BUTTON to display bounds
        const db = display.bounds;
        if (newBtnX < db.x + 5) newBtnX = db.x + 5;
        if (newBtnX > db.x + db.width - 68 - 5) newBtnX = db.x + db.width - 68 - 5;
        if (newY < db.y) newY = db.y;
        if (newY > db.y + db.height - bounds.height) newY = db.y + db.height - bounds.height;

        // Window position follows button (may go slightly off-screen at far edges — that's fine)
        const newWinX = (currentSide === 'left') ? newBtnX : newBtnX - 350;

        state.widgetPos = { x: newBtnX, y: newY };
        state.widgetWindow.setBounds({ x: newWinX, y: newY, width: 418, height: bounds.height });

    } else if (action === 'drag-end') {
        const bounds = state.widgetWindow.getBounds();
        const display = screen.getDisplayMatching(bounds);

        // Determine which edge the button is closer to
        const side = state.widgetSide || 'right';
        const btnScreenX = (side === 'left') ? bounds.x : bounds.x + 350;
        const distLeft = btnScreenX - display.bounds.x;
        const distRight = (display.bounds.x + display.bounds.width) - (btnScreenX + 68);

        let newSide, targetWindowX, targetBtnX;
        if (distLeft < distRight) {
            // Snap to left — buttons go to left edge, panel to the right
            newSide = 'left';
            targetBtnX = display.bounds.x + 10;
            targetWindowX = targetBtnX; // window.x = buttonX (panel is to the right)
        } else {
            // Snap to right — buttons go to right edge, panel to the left
            newSide = 'right';
            targetBtnX = display.bounds.x + display.bounds.width - 68 - 10;
            targetWindowX = targetBtnX - 350; // window.x = buttonX - 350 (panel is to the left)
        }

        state.widgetSide = newSide;
        state.widgetPos = { x: targetBtnX, y: bounds.y };
        store.set('widgetPos', state.widgetPos);
        store.set('widgetSide', newSide);

        state.widgetWindow.setBounds({ x: targetWindowX, y: bounds.y, width: 418, height: bounds.height });
        notifySide();

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
