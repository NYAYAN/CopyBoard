const { app, dialog, clipboard } = require('electron');
const { state } = require('./services/state');
const { showMain, createMainWindow } = require('./services/window-manager');
const { initTray } = require('./services/tray-manager');
const { registerIpcHandlers } = require('./services/ipc-handlers');
const { initAutoUpdater } = require('./services/update-manager');
const { startClipboardWatcher } = require('./services/history-manager');

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.mainWindow) {
      showMain();
    }
  });

  // Global Error Handler
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    dialog.showErrorBox('Beklenmeyen Hata', error.stack || error.message);
  });

  app.whenReady().then(() => {
    console.log('App Starting...');

    // Initialize Services
    initTray();
    createMainWindow();
    registerIpcHandlers();
    initAutoUpdater();

    // Start Clipboard Watcher
    const clipInterval = startClipboardWatcher(clipboard);

    // Platform spec
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: state.autoStart, path: app.getPath('exe'), args: ['--hidden'] });
    }

    app.on('before-quit', () => {
      clearInterval(clipInterval);
      if (state.tray && !state.tray.isDestroyed()) state.tray.destroy();
    });
  });
}
