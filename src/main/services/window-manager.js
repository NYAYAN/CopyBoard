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
        backgroundColor: '#2c2c2e',
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
    // widgetPos stores the unscaled BUTTON logical position. widgetSide tracks left/right.
    state.widgetPos = store.get('widgetPos') || { x: screen.getPrimaryDisplay().workAreaSize.width - 80, y: 100 };
    state.widgetSide = store.get('widgetSide') || 'right';

    const s = (state.widgetScale || 100) / 100;
    const TOTAL_WIDTH = Math.round(418 * s); // 350 panel + 68 buttons scaled
    const COLLAPSED_HEIGHT = Math.round(68 * s);
    const panelScaled = Math.round(350 * s);

    state.widgetWindow = new BrowserWindow({
        width: TOTAL_WIDTH,
        height: COLLAPSED_HEIGHT,
        x: state.widgetSide === 'left' ? state.widgetPos.x : state.widgetPos.x - panelScaled,
        y: state.widgetPos.y,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    state.widgetWindow.setAlwaysOnTop(true, 'screen-saver');
    state.widgetWindow.loadFile(path.join(__dirname, '../../renderer/widget/widget.html'));

    // Notify renderer of the saved side and config once it has loaded
    state.widgetWindow.webContents.on('did-finish-load', () => {
        state.widgetWindow.webContents.setZoomFactor(s);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.showInactive();
        }
        notifySide();
        state.widgetWindow.webContents.send('widget-config', {
            transparent: state.widgetTransparent,
            color: state.widgetColor,
            opacity: state.widgetOpacity !== undefined ? state.widgetOpacity : 100
        });
    });
}

function getWindowX() {
    const s = (state.widgetScale || 100) / 100;
    const panelScaled = Math.round(350 * s);
    // Right side: buttons at right edge → window.x = buttonX - panelScaled
    // Left side:  buttons at left edge → window.x = buttonX
    return state.widgetSide === 'left'
        ? state.widgetPos.x
        : state.widgetPos.x - panelScaled;
}

function notifySide() {
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        state.widgetWindow.webContents.send('widget-side', state.widgetSide || 'right');
    }
}

function handleWidgetAction(action, data) {
    if (!state.widgetWindow || state.widgetWindow.isDestroyed()) return;

    const s = (state.widgetScale || 100) / 100;
    const winX = getWindowX();

    // Scaled dimensions
    const FULL_W = Math.round(418 * s);
    const COL_H = Math.round(68 * s);
    const EXP_H = Math.round(300 * s);
    const HIS_H = Math.round(400 * s);
    const PANEL_W = Math.round(350 * s);
    const BTN_W = Math.round(68 * s);

    // Yön Hesaplama Fonksiyonu
    const calculateDirection = () => {
        const display = screen.getDisplayNearestPoint(state.widgetPos);
        const db = display.workArea;
        const spaceBelow = (db.y + db.height) - state.widgetPos.y;
        const isUp = spaceBelow < HIS_H;
        state.widgetWindow.webContents.send('widget-direction', isUp);
    };

    if (action === 'expand') {
        calculateDirection();
        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: FULL_W, height: EXP_H });
    } else if (action === 'expand-history') {
        calculateDirection();
        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: FULL_W, height: HIS_H });
    } else if (action === 'collapse-history') {
        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: FULL_W, height: EXP_H });
    } else if (action === 'collapse') {
        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: FULL_W, height: COL_H });
    } else if (action === 'drag') {
        const bounds = state.widgetWindow.getBounds();
        const currentSide = state.widgetSide || 'right';
        const currentBtnX = (currentSide === 'left') ? bounds.x : bounds.x + PANEL_W;

        let newBtnX = currentBtnX + (data.x || 0);
        let newY = bounds.y + (data.y || 0);

        // Allow free dragging between monitors (window will follow)
        const newWinX = (currentSide === 'left') ? newBtnX : newBtnX - PANEL_W;
        state.widgetPos = { x: newBtnX, y: newY };
        state.widgetWindow.setBounds({ x: newWinX, y: newY, width: FULL_W, height: bounds.height });

    } else if (action === 'drag-end') {
        // ...Existing drag-end logic...
        calculateDirection();
        // Find nearest display to snap the widget safely within bounds
        const bounds = state.widgetWindow.getBounds();
        const currentSide = state.widgetSide || 'right';
        const btnX = (currentSide === 'left') ? bounds.x : bounds.x + PANEL_W;

        // Get display nearest to the button center
        const display = screen.getDisplayNearestPoint({
            x: Math.round(btnX + BTN_W / 2),
            y: Math.round(bounds.y + COL_H / 2)
        });
        const db = display.workArea;

        // Final Clamping to ensure it doesn't stay off-screen
        let finalBtnX = btnX;
        let finalY = bounds.y;

        if (finalBtnX < db.x) finalBtnX = db.x;
        if (finalBtnX > db.x + db.width - BTN_W) finalBtnX = db.x + db.width - BTN_W;
        if (finalY < db.y) finalY = db.y;
        if (finalY > db.y + db.height - COL_H) finalY = db.y + db.height - COL_H;

        // Determine new side based on which half of the display it's on
        const newSide = (finalBtnX < db.x + db.width / 2) ? 'left' : 'right';

        state.widgetSide = newSide;
        state.widgetPos = { x: finalBtnX, y: finalY };
        store.set('widgetPos', state.widgetPos);
        store.set('widgetSide', newSide);

        const targetWindowX = (newSide === 'left') ? finalBtnX : finalBtnX - PANEL_W;
        state.widgetWindow.setBounds({ x: Math.round(targetWindowX), y: Math.round(finalY), width: FULL_W, height: COL_H });
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

function updateWidgetScale(scaleValue) {
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        const s = scaleValue / 100;
        state.widgetWindow.webContents.setZoomFactor(s);

        // Refresh bounds with new scale by simulating a collapse (or current mode)
        // Assume collapsed for simplest resizing mapping, wait, better yet,
        // we can just re-apply current height logic. But since scale can change quickly, collapsing it is safe.
        const FULL_W = Math.round(418 * s);
        const COL_H = Math.round(68 * s);
        const winX = getWindowX();

        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: FULL_W, height: COL_H });
    }
}

module.exports = {
    showMain,
    createMainWindow,
    createCapture,
    showToast,
    toggleWidget,
    handleWidgetAction,
    updateWidgetScale
};
