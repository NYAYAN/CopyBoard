const { Tray, Menu, app } = require('electron');
const path = require('path');
const { state } = require('./state');
const { showMain, toggleMain, toggleQuickPaste } = require('./window-manager');

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

    // A native menu freezes the main process while it's up (see suspendShortcuts): hotkeys
    // pressed meanwhile are queued and all fire at once when it closes. Drop the
    // registrations for as long as the menu is on screen so a press is simply ignored.
    contextMenu.on('menu-will-show', () => {
        try { require('./ipc/shortcuts').suspendShortcuts(); } catch (e) { console.error('suspendShortcuts failed:', e); }
    });
    contextMenu.on('menu-will-close', () => {
        try { require('./ipc/shortcuts').resumeShortcuts(); } catch (e) { console.error('resumeShortcuts failed:', e); }
    });

    if (process.platform === 'darwin') {
        // setContextMenu() makes a LEFT click open the menu on macOS, which swallowed the
        // 'click' handler below (the icon could never just show the window) and put that
        // freezing modal menu on the most common interaction. Left click toggles the
        // window; the menu — including its own "Göster" — moves to right click.
        tray.on('click', toggleMain);
        tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
    } else {
        // Windows/Linux: right click already opens the menu and 'click' is delivered.
        tray.setContextMenu(contextMenu);
        tray.on('click', toggleMain);
    }
}

module.exports = { initTray };
