const { app, dialog, clipboard, screen, powerMonitor } = require('electron');
const { state } = require('./services/state');
const { showMain, createMainWindow, toggleWidget, handleDisplayChange, createQuickPasteWindow } = require('./services/window-manager');
const { disposePasteHelper } = require('./services/paste-service');
const { initTray } = require('./services/tray-manager');
const { registerIpcHandlers } = require('./services/ipc-handlers');
const { initAutoUpdater, checkForUpdatesSilently } = require('./services/update-manager');
const { startClipboardWatcher, flushHistorySave } = require('./services/history-manager');

// Hot Reload handled externally or disabled

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

    // Initialize Services with Error Handling
    try {
      initTray();
      createMainWindow();
      registerIpcHandlers();
      initAutoUpdater();
    } catch (svcErr) {
      console.error('Service Initialization Failed:', svcErr);
      dialog.showErrorBox('Servis Hatası', 'Uygulama servisleri başlatılamadı: ' + svcErr.message);
      app.quit();
    }

    // Check if launched as a hidden auto-start process
    const isAutoStart = process.argv.includes('--hidden');

    if (!isAutoStart) {
      setTimeout(() => {
        try {
          showMain();
        } catch (e) { console.error('ShowMain failed:', e); }
      }, 300);
    }

    // Start Clipboard Watcher
    let clipInterval = startClipboardWatcher(clipboard);

    // Pause the 1s clipboard poll while the machine is asleep or locked (saves wakeups/battery).
    // Also flush the debounced history write — sleep can outlive its 500ms window.
    const pausePoll = () => {
        if (clipInterval) { clearInterval(clipInterval); clipInterval = null; }
        flushHistorySave();
    };
    const resumePoll = () => { if (!clipInterval) clipInterval = startClipboardWatcher(clipboard); };
    powerMonitor.on('suspend', pausePoll);
    powerMonitor.on('lock-screen', pausePoll);
    powerMonitor.on('resume', resumePoll);
    powerMonitor.on('unlock-screen', resumePoll);

    // Monitor for display changes to prevent widget from getting lost
    screen.on('display-added', () => {
      console.log('Display added, checking widget focus...');
      handleDisplayChange();
    });

    screen.on('display-removed', () => {
      console.log('Display removed, checking widget focus...');
      handleDisplayChange();
    });

    screen.on('display-metrics-changed', () => {
      console.log('Display metrics changed, re-validating widget position...');
      handleDisplayChange();
    });

    // Pre-create the quick-paste picker (hidden) so the first Ctrl+Shift+V opens instantly.
    try {
      createQuickPasteWindow();
    } catch (e) { console.error('QuickPaste init failed:', e); }

    // Initialize Widget if enabled in settings
    if (state.showWidget) {
      try {
        toggleWidget(true);
      } catch (e) { console.error('Widget init failed:', e); }
    }

    // Platform spec
    if (app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: state.autoStart, path: app.getPath('exe'), args: ['--hidden'] });
      } catch (e) { }
    }

    // Silent startup update check (packaged builds only). README advertises a startup
    // auto-check; this stays quiet unless an update is available, in which case the
    // 'update-available' handler opens the dialog. Delayed so it doesn't compete with launch.
    if (app.isPackaged) {
      setTimeout(() => {
        try { checkForUpdatesSilently(); } catch (e) { console.error('Auto update check failed:', e); }
      }, 5000);
    }

    app.on('before-quit', () => {
      clearInterval(clipInterval);
      flushHistorySave(); // persist any copy still inside the 500ms debounce window
      disposePasteHelper();
      if (state.tray && !state.tray.isDestroyed()) state.tray.destroy();
    });
  });
}
