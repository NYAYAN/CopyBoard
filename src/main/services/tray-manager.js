const { Tray, Menu, app } = require('electron');
const path = require('path');
const { state } = require('./state');
const { showMain, createCapture } = require('./window-manager');

function initTray() {
    // Correct path relative to src/main/services
    let iconPath = process.platform === 'darwin'
        ? path.join(__dirname, '../../../trayIcon.png') // up 3 levels to root? No. src/main/services -> src/main -> src -> root
        // main.js was in src/main. join(__dirname, '../../icon.png') worked.
        // So services -> main -> src -> root is 3 levels.
        : path.join(__dirname, '../../../icon.png');

    if (process.platform === 'darwin') {
        app.dock.hide();
    }

    const tray = new Tray(iconPath);
    state.tray = tray;
    tray.setToolTip('CopyBoard');

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Göster', click: showMain },
        { type: 'separator' },
        {
            label: 'Ekran Görüntüsü Al', click: () => {
                const { capture } = require('./ipc-handlers'); // Circular dependency avoidance if needed
                // Actually capture logic is in ipc-handlers mostly, but creating capture window is WindowManager. 
                // We need the `capture` ORCHESTRATOR function which handles desktopCapturer.
                // Let's assume passed in or handle it here?
                // Better: Make a capture helper in a utils or separate file. 
                // For now, let's keep it simple. We can emit an event or require properly.
                // Or simply call a global function if we attach it to 'global' (ugly).
                // Let's refactor `capture()` into a service too.
                require('./capture-service').startCapture('draw');
            }
        },
        { label: 'Metin Oku (OCR)', click: () => require('./capture-service').startCapture('ocr') },
        { label: 'Video Kaydet', click: () => require('./capture-service').startCapture('video') },
        { type: 'separator' },
        { label: 'Çıkış', click: () => app.quit() }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('click', showMain);
}

module.exports = { initTray };
