const { Tray, Menu, app } = require('electron');
const path = require('path');
const { state } = require('./state');
const { showMain, toggleMain, toggleQuickPaste } = require('./window-manager');
const { t } = require('./i18n');

// The tray menu carries each action's own global shortcut as its ACCELERATOR — not just
// for discoverability. A native macOS menu runs a modal event-tracking loop in which the
// main process stops servicing globalShortcut callbacks, so a hotkey pressed while the
// menu is open used to do nothing and then fire (along with every other press) the moment
// the menu closed. A menu key equivalent is handled by the menu itself during that loop,
// so the shortcut works immediately while the menu is up. The global registrations are
// suspended for the same window (see suspendShortcuts) so the press can't ALSO be queued
// and replayed afterwards as a second trigger.
let contextMenu = null;

function buildMenu() {
    const all = state.shortcuts || {};
    const on = all.enabled || {};
    // Lazy: shortcuts.js reaches back here to rebuild the menu, so a top-level require
    // would be a load-order cycle.
    const { menuAccelerator } = require('./ipc/shortcuts');
    // A switched-off shortcut isn't registered, so don't advertise it on the menu either —
    // and don't let the menu honour it while open. The item itself still works by clicking.
    // menuAccelerator also drops bindings whose key has no accelerator name at all (the
    // native-only ones) — Menu.buildFromTemplate throws on those.
    const s = new Proxy({}, { get: (_, k) => (on[k] === false ? undefined : menuAccelerator(all[k])) });
    const menu = Menu.buildFromTemplate([
        { label: t('Göster'), accelerator: s.list, click: showMain },
        // Always-available way to open the picker even when its global hotkey is
        // claimed/blocked (another clipboard app, RDP/endpoint policy, reserved combo).
        { label: t('Hızlı Yapıştır'), accelerator: s.paste, click: () => toggleQuickPaste() },
        { type: 'separator' },
        { label: t('Ekran Görüntüsü Al'), accelerator: s.draw, click: () => require('./capture-service').startCapture('draw') },
        { label: t('Metin Oku (OCR)'), accelerator: s.ocr, click: () => require('./capture-service').startCapture('ocr') },
        { label: t('Renk Kodu Al'), accelerator: s.color, click: () => require('./capture-service').startCapture('color') },
        { label: t('Kaydırmalı Yakalama'), accelerator: s.scroll, click: () => require('./capture-service').startCapture('scroll') },
        { label: t('Video Kaydet'), accelerator: s.video, click: () => require('./capture-service').startCapture('video') },
        { type: 'separator' },
        { label: t('Çıkış'), click: () => app.quit() }
    ]);

    menu.on('menu-will-show', () => {
        try { require('./ipc/shortcuts').suspendShortcuts(); } catch (e) { console.error('suspendShortcuts failed:', e); }
    });
    menu.on('menu-will-close', () => {
        try { require('./ipc/shortcuts').resumeShortcuts(); } catch (e) { console.error('resumeShortcuts failed:', e); }
    });

    return menu;
}

// Settings can change a shortcut at any time; the menu is built once, so rebuild it or the
// accelerators (and the keys that work while it's open) would drift from the real bindings.
function rebuildTrayMenu() {
    if (!state.tray || state.tray.isDestroyed()) return;
    contextMenu = buildMenu();
    if (process.platform !== 'darwin') state.tray.setContextMenu(contextMenu);
}

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

    contextMenu = buildMenu();

    if (process.platform === 'darwin') {
        // setContextMenu() makes a LEFT click open the menu on macOS, which swallowed the
        // 'click' handler below (the icon could never just show the window) and put that
        // freezing modal menu on the most common interaction. Left click toggles the
        // window; the menu — including its own t("Göster") — moves to right click.
        //
        // popUpContextMenu() does NOT emit the menu's will-show/will-close events, so the
        // suspend/resume pair is driven from here as well; the call itself returns once the
        // menu is dismissed.
        tray.on('click', toggleMain);
        tray.on('right-click', () => {
            const shortcuts = require('./ipc/shortcuts');
            try { shortcuts.suspendShortcuts(); } catch (e) { console.error('suspendShortcuts failed:', e); }
            try {
                tray.popUpContextMenu(contextMenu);
            } finally {
                try { shortcuts.resumeShortcuts(); } catch (e) { console.error('resumeShortcuts failed:', e); }
            }
        });
    } else {
        // Windows/Linux: right click already opens the menu and 'click' is delivered.
        tray.setContextMenu(contextMenu);
        tray.on('click', toggleMain);
    }
}

module.exports = { initTray, rebuildTrayMenu };
