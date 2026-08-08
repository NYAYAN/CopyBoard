const { BrowserWindow, screen, app, dialog, globalShortcut, desktopCapturer } = require('electron');
const path = require('path');
const { state, store } = require('./state');
const { warmPasteHelper } = require('./paste-service');

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
        // History pushes skip hidden windows (see history-manager broadcast), so the list
        // may be stale from before the window was hidden — refresh it now that it's visible.
        state.mainWindow.webContents.send('update-history', {
            history: state.history,
            favorites: state.favorites
        });
    }
}

function createMainWindow() {
    state.mainWindow = new BrowserWindow({
        width: 350, height: 550, frame: false, show: false, skipTaskbar: true,
        transparent: process.platform === 'darwin',
        vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
        visualEffectState: 'active',
        backgroundColor: '#2c2c2e',
        fullscreenable: false,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    // macOS Spaces: without this the window belongs to the Space it was last shown on,
    // so the global shortcut yanks the user over to that desktop instead of opening the
    // popup on the current one. Joining all workspaces (like the widget and quick-paste
    // windows) makes it appear wherever the user is.
    state.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

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
    // Fullscreen on the target display (x/y select the monitor). Fullscreen hides the OS
    // taskbar so it isn't shown twice (real taskbar + the taskbar baked into the captured
    // screenshot). This is per-monitor: the original single-window code already opened a
    // fullscreen overlay on whichever monitor the cursor was on, secondary monitors included.
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
            sandbox: true,
            zoomFactor: 1.0
        }
    });

    // The video recorder captures the LIVE desktop via getUserMedia, so this fullscreen
    // overlay window — its pulsing selection outline, toolbar and timer — would otherwise
    // be filmed into the recording. Exclude it from all screen capture (including our own
    // getUserMedia) while keeping it visible to the user: WDA_EXCLUDEFROMCAPTURE on Windows,
    // NSWindowSharingNone on macOS. Snipper/OCR annotate a pre-captured PNG, so they don't
    // need this.
    if (type === 'video') {
        try { win.setContentProtection(true); } catch (e) { console.error('setContentProtection failed:', e); }

        // macOS system-audio capture. Chromium's getUserMedia desktop-loopback trick (used on
        // Windows) is unavailable on macOS, so the recorder falls back to getDisplayMedia there.
        // This handler fulfils that request with a screen source + loopback audio; the renderer
        // discards the video track and keeps only the audio. Loopback audio works only on
        // supported macOS versions — if unavailable the stream has no audio track and the
        // recorder warns the user (about needing a virtual audio device) and records without it.
        if (process.platform === 'darwin') {
            try {
                win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
                    desktopCapturer.getSources({ types: ['screen'] })
                        .then(sources => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
                        .catch(err => { console.error('DisplayMedia source failed:', err); callback({}); });
                }, { useSystemPicker: false });
            } catch (e) { console.error('setDisplayMediaRequestHandler failed:', e); }
        }
    }

    // Hide Widget during capture
    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        state.widgetWindow.hide();
    }

    // __dirname is src/main/services → go up two levels to reach src/renderer
    const rendererPath = path.resolve(__dirname, '../../renderer');

    if (type === 'ocr') win.loadFile(path.join(rendererPath, 'ocr/ocr.html'));
    else if (type === 'video') win.loadFile(path.join(rendererPath, 'recorder/recorder.html'));
    else win.loadFile(path.join(rendererPath, 'snipper/snipper.html'));

    const level = process.platform === 'darwin' ? 'pop-up-menu' : 'screen-saver';
    win.setAlwaysOnTop(true, level);

    win.webContents.setWindowOpenHandler(() => { return { action: 'deny' }; });

    win.on('closed', () => {
        state.captureWindows = state.captureWindows.filter(w => w !== win);
        if (type === 'ocr' && state.ocrWindow === win) state.ocrWindow = null;
        else if (type === 'video' && state.recorderWindow === win) state.recorderWindow = null;
        else if (state.snipperWindow === win) state.snipperWindow = null;

        // End the capture session only once EVERY monitor's overlay is gone, so the
        // widget doesn't flash back while other capture windows are still open.
        if (state.captureWindows.length === 0) {
            state.isCapturing = false;
            if (state.showWidget) toggleWidget(true);
        }
    });

    if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.setKiosk(false);
    }

    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') {
            event.preventDefault();
            closeAllCaptureWindows(); // ESC on any monitor cancels the whole capture
        }
    });

    if (type === 'ocr') state.ocrWindow = win;
    else if (type === 'video') state.recorderWindow = win;
    else state.snipperWindow = win;
    state.captureWindows.push(win);

    return win;
}

// Close every capture overlay (across all monitors). Pass a window to keep alive — used
// when a video recording starts on one monitor and the overlays on the others must go away.
function closeAllCaptureWindows(exceptWin = null) {
    state.captureWindows.slice().forEach(w => {
        if (w && !w.isDestroyed() && w !== exceptWin) w.close();
    });
}

// The toast window is created ONCE and reused: every toast used to destroy the old
// window and spawn a fresh BrowserWindow — a whole renderer process (~100-300ms of
// CPU) per notification. Now it hides on finish and is repositioned + reshown here.
// Feedback belongs on the display the user is working on (cursor), not always the
// primary one — recomputed per toast since the cursor moves between displays.
function positionToastWindow() {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    state.toastWindow.setBounds({ x: wa.x + wa.width - 370, y: wa.y + 50, width: 320, height: 100 });
}

function showToast(message, type = 'info') {
    try {
        if (state.toastWindow && !state.toastWindow.isDestroyed()) {
            if (state.toastReady) {
                positionToastWindow();
                state.toastWindow.showInactive();
                state.toastWindow.webContents.send('display-toast', message, type);
            } else {
                state.pendingToast = [message, type]; // still loading — delivered on ready
            }
            return;
        }
        state.toastReady = false;
        state.pendingToast = [message, type];
        state.toastWindow = new BrowserWindow({
            width: 320, height: 100,
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
        // macOS: also show over fullscreen Spaces (the toast is inactive + click-through,
        // so it can't disturb the fullscreen app). skipTransformProcessType keeps the
        // default process-type transform from flashing windows when the toast appears.
        state.toastWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        state.toastWindow.setIgnoreMouseEvents(true);
        state.toastWindow.on('closed', () => { state.toastWindow = null; state.toastReady = false; });
        state.toastWindow.loadFile(path.join(__dirname, '../../renderer/toast/toast.html'));
        state.toastWindow.once('ready-to-show', () => {
            if (!state.toastWindow || state.toastWindow.isDestroyed()) return;
            state.toastReady = true;
            const pending = state.pendingToast; // latest wins if several queued during load
            state.pendingToast = null;
            if (pending) {
                positionToastWindow();
                state.toastWindow.showInactive();
                state.toastWindow.webContents.send('display-toast', pending[0], pending[1]);
            }
        });
    } catch (e) { console.error('Toast Error:', e); }
}

function toggleWidget(show) {
    if (show) {
        if (!state.widgetWindow || state.widgetWindow.isDestroyed()) {
            createWidgetWindow();
        } else {
            state.widgetWindow.showInactive();
            state.widgetWindow.moveTop();
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

    // Ensure the saved position is visible on current displays
    ensureWidgetInBounds();

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

    state.widgetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    state.widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    state.widgetWindow.loadFile(path.join(__dirname, '../../renderer/widget/widget.html'));

    // Keep widget always on top — re-apply on every show
    state.widgetWindow.on('show', () => {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
            state.widgetWindow.moveTop();
        }
    });

    // Periodic alwaysOnTop refresh to prevent other windows from covering widget.
    // 10s is enough: this is only a safety net — topmost is also re-asserted on 'show'
    // and after every bounds change, so the interval rarely does real work. (Was 3s,
    // which kept waking the process for nothing.)
    state._widgetTopInterval = setInterval(() => {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed() && state.widgetWindow.isVisible()) {
            // Unconditionally re-assert to stay ahead of other topmost windows
            state.widgetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
            state.widgetWindow.moveTop();
        } else if (!state.widgetWindow || state.widgetWindow.isDestroyed()) {
            clearInterval(state._widgetTopInterval);
            state._widgetTopInterval = null;
        }
    }, 10000);

    state.widgetWindow.on('closed', () => {
        if (state._widgetTopInterval) {
            clearInterval(state._widgetTopInterval);
            state._widgetTopInterval = null;
        }
    });

    // Notify renderer of the saved side and config once it has loaded
    state.widgetWindow.webContents.on('did-finish-load', () => {
        state.widgetWindow.webContents.setZoomFactor(s);
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.showInactive();
            state.widgetWindow.moveTop();
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
    const EXP_H = Math.round(350 * s);
    const HIS_H = Math.round(400 * s);
    const PANEL_W = Math.round(350 * s);
    const BTN_W = Math.round(68 * s);

    const baseY = state.widgetPos ? Math.round(state.widgetPos.y) : 100;

    // Decide whether panels open upward (when there isn't enough room below the
    // button) and notify the renderer so it can mirror the layout in CSS.
    const calculateDirection = () => {
        const display = screen.getDisplayNearestPoint(state.widgetPos);
        const db = display.workArea;
        const spaceBelow = (db.y + db.height) - state.widgetPos.y;
        const isUp = spaceBelow < HIS_H;
        state.widgetWindow.webContents.send('widget-direction', isUp);
        return isUp;
    };

    // Top-align the window when opening down; bottom-align the button (window
    // grows upward) when opening up — so the button never moves on screen.
    const topYFor = (height, isUp) => isUp ? Math.round(baseY + COL_H - height) : baseY;

    if (action === 'expand') {
        const isUp = calculateDirection();
        state.widgetWindow.setBounds({ x: Math.round(winX), y: topYFor(EXP_H, isUp), width: FULL_W, height: EXP_H });
    } else if (action === 'expand-history') {
        const isUp = calculateDirection();
        state.widgetWindow.setBounds({ x: Math.round(winX), y: topYFor(HIS_H, isUp), width: FULL_W, height: HIS_H });
    } else if (action === 'collapse-history') {
        const isUp = calculateDirection();
        state.widgetWindow.setBounds({ x: Math.round(winX), y: topYFor(EXP_H, isUp), width: FULL_W, height: EXP_H });
    } else if (action === 'collapse') {
        state.widgetWindow.setBounds({ x: Math.round(winX), y: baseY, width: FULL_W, height: COL_H });
    }

    // Always re-assert topmost after bound changes in widget mode
    if (['expand', 'expand-history', 'collapse-history', 'collapse'].includes(action)) {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            state.widgetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
            state.widgetWindow.moveTop();
        }
    }

    if (action === 'drag') {
        const bounds = state.widgetWindow.getBounds();
        const currentSide = state.widgetSide || 'right';
        const currentBtnX = (currentSide === 'left') ? bounds.x : bounds.x + PANEL_W;

        let newBtnX = currentBtnX + (data.x || 0);
        let newY = bounds.y + (data.y || 0);

        // Allow free dragging between monitors (window will follow)
        const newWinX = (currentSide === 'left') ? newBtnX : newBtnX - PANEL_W;
        state.widgetPos = { x: newBtnX, y: newY };
        state.widgetWindow.setBounds({ x: newWinX, y: newY, width: FULL_W, height: bounds.height });
        // Re-assert topmost after bounds change
        state.widgetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        state.widgetWindow.moveTop();

    } else if (action === 'drag-end') {
        const bounds = state.widgetWindow.getBounds();
        const currentSide = state.widgetSide || 'right';
        const btnX = (currentSide === 'left') ? bounds.x : bounds.x + PANEL_W;

        const display = screen.getDisplayNearestPoint({
            x: Math.round(btnX + BTN_W / 2),
            y: Math.round(bounds.y + COL_H / 2)
        });
        const db = display.workArea;

        let finalBtnX = btnX;
        let finalY = bounds.y;

        // Snapping Thresholds (60px)
        const SNAP_THRESHOLD = 60;
        const MARGIN = 10;

        const distLeft = Math.abs(finalBtnX - db.x);
        const distRight = Math.abs(finalBtnX - (db.x + db.width - BTN_W));
        const distTop = Math.abs(finalY - db.y);
        const distBottom = Math.abs(finalY - (db.y + db.height - COL_H));

        if (distLeft < SNAP_THRESHOLD) finalBtnX = db.x + MARGIN;
        else if (distRight < SNAP_THRESHOLD) finalBtnX = db.x + db.width - BTN_W - MARGIN;

        if (distTop < SNAP_THRESHOLD) finalY = db.y + MARGIN;
        else if (distBottom < SNAP_THRESHOLD) finalY = db.y + db.height - COL_H - MARGIN;

        // General clamping to keep it on-screen
        if (finalBtnX < db.x) finalBtnX = db.x + MARGIN;
        if (finalBtnX > db.x + db.width - BTN_W) finalBtnX = db.x + db.width - BTN_W - MARGIN;
        if (finalY < db.y) finalY = db.y + MARGIN;
        if (finalY > db.y + db.height - COL_H) finalY = db.y + db.height - COL_H - MARGIN;

        const newSide = (finalBtnX < db.x + db.width / 2) ? 'left' : 'right';

        state.widgetSide = newSide;
        state.widgetPos = { x: finalBtnX, y: finalY };
        store.set('widgetPos', state.widgetPos);
        store.set('widgetSide', newSide);

        // Relative coordinates (0.0 to 1.0)
        const relX = (finalBtnX - db.x) / (db.width - BTN_W);
        const relY = (finalY - db.y) / (db.height - COL_H);

        store.set('widgetDockParams', {
            displayId: display.id,
            relX,
            relY,
            side: newSide
        });

        const targetWindowX = (newSide === 'left') ? finalBtnX : finalBtnX - PANEL_W;
        state.widgetWindow.setBounds({ x: Math.round(targetWindowX), y: Math.round(finalY), width: FULL_W, height: COL_H });
        calculateDirection();
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
        const FULL_W = Math.round(418 * s);
        const COL_H = Math.round(68 * s);
        const winX = getWindowX();

        state.widgetWindow.setBounds({ x: winX, y: state.widgetPos.y, width: FULL_W, height: COL_H });
    }
}

/**
 * Ensures the widget is within at least one of the current displays.
 * Restores position using relative coordinates for stability during transitions.
 */
function ensureWidgetInBounds() {
    let targetDisplay;
    const s = (state.widgetScale || 100) / 100;
    const BTN_SIZE = Math.round(68 * s);

    if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
        const winBounds = state.widgetWindow.getBounds();
        targetDisplay = screen.getDisplayMatching(winBounds);
    }

    let dockParams = store.get('widgetDockParams');
    if (!targetDisplay) {
        const displays = screen.getAllDisplays();
        targetDisplay = displays.find(d => d.id === (dockParams && dockParams.displayId)) || screen.getPrimaryDisplay();
    }
    const db = targetDisplay.workArea;
    const safeWidth = Math.max(1, db.width - BTN_SIZE);
    const safeHeight = Math.max(1, db.height - BTN_SIZE);

    // Use relative coordinates if available
    let newX, newY;
    if (dockParams && dockParams.relX !== undefined) {
        newX = db.x + (dockParams.relX * safeWidth);
        newY = db.y + (dockParams.relY * safeHeight);
    } else {
        // Fallback to absolute or default
        newX = state.widgetPos ? state.widgetPos.x : db.x + db.width - BTN_SIZE - 10;
        newY = state.widgetPos ? state.widgetPos.y : db.y + 100;
    }

    // Clamp to screen bounds
    if (newX < db.x) newX = db.x + 10;
    if (newX > db.x + db.width - BTN_SIZE) newX = db.x + db.width - BTN_SIZE - 10;
    if (newY < db.y) newY = db.y + 10;
    if (newY > db.y + db.height - BTN_SIZE) newY = db.y + db.height - BTN_SIZE - 10;

    const newSide = (newX < db.x + db.width / 2) ? 'left' : 'right';

    state.widgetPos = { x: Math.round(newX), y: Math.round(newY) };
    state.widgetSide = newSide;

    store.set('widgetPos', state.widgetPos);
    store.set('widgetSide', state.widgetSide);
    
    // Refresh dock params
    store.set('widgetDockParams', {
        displayId: targetDisplay.id,
        relX: (state.widgetPos.x - db.x) / safeWidth,
        relY: (state.widgetPos.y - db.y) / safeHeight,
        side: newSide
    });
}

/**
 * Called when displays are added/removed/resized.
 */
let activeSyncTimeouts = [];

function handleDisplayChange() {
    // Clear all existing timeouts for previous events
    activeSyncTimeouts.forEach(t => clearTimeout(t));
    activeSyncTimeouts = [];
    
    const runSync = () => {
        if (state.widgetWindow && !state.widgetWindow.isDestroyed()) {
            ensureWidgetInBounds();
            const s = (state.widgetScale || 100) / 100;
            const FULL_W = Math.round(418 * s);
            const COL_H = Math.round(68 * s);
            const winX = getWindowX();

            state.widgetWindow.setBounds({
                x: Math.round(winX),
                y: Math.round(state.widgetPos.y),
                width: FULL_W,
                height: COL_H
            });
            notifySide();
        }
    };

    // Triple-Check Sequence: catch OS re-layouts during multi-monitor flashes
    activeSyncTimeouts.push(setTimeout(runSync, 500));
    activeSyncTimeouts.push(setTimeout(runSync, 2000));
    activeSyncTimeouts.push(setTimeout(runSync, 5000));
}

// ── Quick-Paste Picker ──────────────────────────────────────────────────────
// A compact clipboard picker opened by a global shortcut. Created with
// focusable:false so it NEVER steals focus from the text field the user is in —
// which is what lets us paste straight into that field after a pick (the
// 'quickpaste-pick' handler puts the text on the clipboard and fires Ctrl+V).
//
// Esc-to-close: the picker is focusable:false so it can't catch a keydown itself.
// We register Esc as a global accelerator only while it's visible (showQuickPaste)
// and drop it again on every 'hide'.
function unregisterQuickPasteEsc() {
    try { if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape'); } catch (e) {}
}

function createQuickPasteWindow() {
    state.quickPasteWindow = new BrowserWindow({
        width: 300,
        height: 380,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        focusable: false,
        backgroundColor: '#00000000',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    state.quickPasteWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    state.quickPasteWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    state.quickPasteWindow.loadFile(path.join(__dirname, '../../renderer/quickpaste/quickpaste.html'));

    state.quickPasteWindow.on('hide', unregisterQuickPasteEsc);
    state.quickPasteWindow.on('closed', () => { state.quickPasteWindow = null; });
}

// Place the picker next to the mouse cursor, flipped/clamped to stay fully on the
// current display's work area.
function positionQuickPasteAtCursor() {
    const W = 300, H = 380, GAP = 12;
    const pt = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(pt).workArea;

    let x = pt.x + GAP;
    let y = pt.y + GAP;
    if (x + W > wa.x + wa.width) x = pt.x - W - GAP;  // flip to the left of the cursor
    if (y + H > wa.y + wa.height) y = pt.y - H - GAP; // flip above the cursor
    x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - W - 8));
    y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - H - 8));

    state.quickPasteWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: H });
}

function showQuickPaste() {
    if (!state.quickPasteWindow || state.quickPasteWindow.isDestroyed()) return;
    positionQuickPasteAtCursor();
    // showInactive (not show) so the user's current app keeps OS keyboard focus.
    state.quickPasteWindow.showInactive();
    state.quickPasteWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    state.quickPasteWindow.moveTop();
    state.quickPasteWindow.webContents.send('quickpaste-show', { count: state.quickPasteCount });
    // Esc closes the picker while it's open (dropped again on 'hide').
    try {
        if (!globalShortcut.isRegistered('Escape')) globalShortcut.register('Escape', hideQuickPaste);
    } catch (e) { /* Esc is a bonus; the X button still closes it */ }
    // Prewarm the paste helper now so the actual Ctrl+V is instant once they click.
    warmPasteHelper();
}

function toggleQuickPaste() {
    if (state.quickPasteWindow && !state.quickPasteWindow.isDestroyed() && state.quickPasteWindow.isVisible()) {
        hideQuickPaste();
        return;
    }
    if (!state.quickPasteWindow || state.quickPasteWindow.isDestroyed()) {
        createQuickPasteWindow();
        state.quickPasteWindow.webContents.once('did-finish-load', showQuickPaste);
    } else {
        showQuickPaste();
    }
}

function hideQuickPaste() {
    if (state.quickPasteWindow && !state.quickPasteWindow.isDestroyed() && state.quickPasteWindow.isVisible()) {
        state.quickPasteWindow.hide();
    }
}

module.exports = {
    showMain,
    createMainWindow,
    createCapture,
    showToast,
    toggleWidget,
    handleWidgetAction,
    updateWidgetScale,
    handleDisplayChange,
    closeAllCaptureWindows,
    createQuickPasteWindow,
    toggleQuickPaste,
    hideQuickPaste
};
