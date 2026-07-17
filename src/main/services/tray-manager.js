const { Tray, Menu, app } = require('electron');
const path = require('path');
const { state } = require('./state');
const { showMain, createCapture, toggleQuickPaste } = require('./window-manager');

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
        // Always-available way to open the picker even when its global hotkey is
        // claimed/blocked (another clipboard app, RDP/endpoint policy, reserved combo).
        { label: 'Hızlı Yapıştır', click: () => toggleQuickPaste() },
        { type: 'separator' },
        { label: 'Ekran Görüntüsü Al', click: () => require('./capture-service').startCapture('draw') },
        { label: 'Metin Oku (OCR)', click: () => require('./capture-service').startCapture('ocr') },
        { label: 'Video Kaydet', click: () => require('./capture-service').startCapture('video') },
        { type: 'separator' },
        { label: 'Çıkış', click: () => app.quit() }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('click', showMain);
}

module.exports = { initTray };
