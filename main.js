const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, clipboard, screen, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const Tesseract = require('tesseract.js');
const crypto = require('crypto');

const store = new Store();

// --- Migration ---
// GLOBAL ERROR HANDLER
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  dialog.showErrorBox('Beklenmeyen Hata', error.stack || error.message);
});

let savedHistory = store.get('history', []);
let hasChanges = false;
savedHistory = savedHistory.map(item => {
  if (typeof item === 'string') {
    hasChanges = true;
    return { id: crypto.randomUUID(), content: item, timestamp: new Date().toISOString(), isFavorite: false };
  }
  if (!item.id) {
    hasChanges = true;
    item.id = crypto.randomUUID();
  }
  if (item.isFavorite === undefined) {
    hasChanges = true;
    item.isFavorite = false;
  }
  return item;
});
if (hasChanges) store.set('history', savedHistory);

const state = {
  mainWindow: null,
  snipperWindow: null,
  ocrWindow: null,
  recorderWindow: null,
  tray: null,
  toastWindow: null,
  history: savedHistory,
  maxItems: store.get('maxItems', 50),
  autoStart: store.get('autoStart', true),
  videoQuality: store.get('videoQuality', 'high'),
  shortcuts: {
    list: store.get('globalShortcut', 'Alt+V'),
    draw: store.get('globalShortcutImage', 'Alt+9'),
    video: store.get('globalShortcutVideo', 'Alt+8'),
    ocr: store.get('globalShortcutOcr', 'Alt+2')
  },
  lastText: '',
  lastMode: 'draw',
  tempVideoPath: null,
  isCapturing: false
};

// --- Toast ---
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
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    state.toastWindow.setAlwaysOnTop(true, 'screen-saver');
    state.toastWindow.loadFile(path.join(__dirname, 'toast.html'));
    state.toastWindow.once('ready-to-show', () => {
      if (state.toastWindow && !state.toastWindow.isDestroyed()) {
        state.toastWindow.showInactive();
        state.toastWindow.webContents.send('display-toast', message, type);
      }
    });
    state.toastWindow.setIgnoreMouseEvents(true);
  } catch (e) { console.error('Toast Error:', e); }
}

function addHistory(content) {
  if (!content) return;
  const existingIndex = state.history.findIndex(i => i.content === content);
  let isFav = false;
  if (existingIndex !== -1) {
    isFav = state.history[existingIndex].isFavorite;
    state.history.splice(existingIndex, 1);
  }
  const newItem = {
    id: crypto.randomUUID(),
    content,
    timestamp: new Date().toISOString(),
    isFavorite: isFav
  };
  state.history.unshift(newItem);
  if (state.history.length > state.maxItems) {
    let deleted = false;
    for (let i = state.history.length - 1; i >= 0; i--) {
      if (!state.history[i].isFavorite) {
        state.history.splice(i, 1);
        deleted = true;
        break;
      }
    }
    if (!deleted && state.history.length > state.maxItems) state.history.pop();
  }
  store.set('history', state.history);
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('update-history', state.history);
  }
}

function updateShortcut(key, shortcut, storeKey) {
  // Validate shortcut - must contain only ASCII characters
  const isValidShortcut = (s) => {
    if (!s) return false;
    // Check if all characters are ASCII
    return /^[\x00-\x7F]+$/.test(s);
  };

  if (!isValidShortcut(shortcut)) {
    console.error(`Invalid shortcut rejected: "${shortcut}" - contains non-ASCII characters`);
    showToast('Geçersiz Kısayol - Sadece ASCII karakterler kullanın', 'error');
    return;
  }

  try { globalShortcut.unregister(state.shortcuts[key]); } catch (e) { }
  state.shortcuts[key] = shortcut;
  store.set(storeKey, shortcut);
  globalShortcut.register(shortcut, () => {
    if (key === 'list') showMain();
    else capture(key);
  });
}

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
    state.mainWindow.webContents.send('reset-view');
  }
}

function createCapture(type = 'draw', display = null) {
  if (!display) display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true,
    fullscreen: process.platform !== 'darwin', // Use native fullscreen on Windows
    simpleFullscreen: process.platform === 'darwin', // Use simple on Mac
    skipTaskbar: true, movable: false, resizable: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    // type: 'panel', // REMOVED: Can cause input issues
    enableLargerThanScreen: true,
    hasShadow: false,
    focusable: true, // EXPLICITLY FOCUSABLE
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }
  });

  let file = 'snipper.html';
  if (type === 'ocr') file = 'ocr.html';
  if (type === 'video') file = 'recorder.html';

  win.loadFile(path.join(__dirname, file));

  // Window Level Logic
  // Windows: 'screen-saver' is robust for overlays.
  // macOS: 'pop-up-menu' is the best balance for overlays that need input.
  const level = process.platform === 'darwin' ? 'pop-up-menu' : 'screen-saver';
  win.setAlwaysOnTop(true, level);
  win.webContents.setWindowOpenHandler(() => { return { action: 'deny' }; });

  win.on('closed', () => {
    state.isCapturing = false;
    if (type === 'ocr') state.ocrWindow = null;
    else if (type === 'video') state.recorderWindow = null;
    else state.snipperWindow = null;
  });

  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setKiosk(false);
    // Force simple fullscreen behavior if needed, though simpleFullscreen: true in constructor usually suffices
  }


  // --- GLOBAL SAFETY SHORTCUT FOR THIS WINDOW ---
  // In case UI freezes, Cmd+Escape (or just Escape) should close it.
  // We handle this via local checking in renderer, but let's ensure it here too.
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

async function capture(mode) {
  if (state.isCapturing) {
    showToast('İşlem devam ediyor...', 'warning');
    return;
  }
  state.isCapturing = true;

  try {
    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const { width, height } = display.bounds;

    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const source = sources.find(s => s.display_id == display.id) || sources[0];

    if (source) {
      const data = source.thumbnail.toDataURL();
      const sourceId = source.id;
      state.lastMode = mode;
      const win = createCapture(mode, display);
      win.webContents.on('did-finish-load', () => {
        if (!win.isDestroyed()) win.webContents.send('capture-screen', data, mode, sourceId, state.videoQuality);
      });
    } else {
      state.isCapturing = false;
    }
  } catch (e) {
    state.isCapturing = false;
    showToast('Capture Hatası', 'error');
    console.error(e);
  }
}

app.whenReady().then(() => {
  // Log registered IPC channels for debugging
  console.log('=== IPC LISTENERS BEING REGISTERED ===');

  let iconPath = process.platform === 'darwin'
    ? path.join(__dirname, 'trayIcon.png')
    : path.join(__dirname, 'icon.png');
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
  const tray = new Tray(iconPath);
  state.tray = tray;
  tray.setToolTip('CopyBoard');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Göster', click: showMain },
    { type: 'separator' },
    { label: 'Ekran Görüntüsü Al', click: () => capture('draw') },
    { label: 'Metin Oku (OCR)', click: () => capture('ocr') },
    { label: 'Video Kaydet', click: () => capture('video') },
    { type: 'separator' },
    { label: 'Çıkış', click: () => app.quit() }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', showMain);

  state.mainWindow = new BrowserWindow({
    width: 350, height: 550, frame: false, show: false, skipTaskbar: true,
    transparent: process.platform === 'darwin',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }
  });

  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  state.mainWindow.loadFile('index.html');
  state.mainWindow.on('blur', () => state.mainWindow.hide());

  const clipboardInterval = setInterval(() => {
    const t = clipboard.readText();
    if (t && t !== state.lastText) { state.lastText = t; addHistory(t); }
  }, 1000);

  // --- CLEANUP ON QUIT to prevent 0x80000003 error ---
  app.on('before-quit', () => {
    clearInterval(clipboardInterval);
    if (state.tray && !state.tray.isDestroyed()) state.tray.destroy();
  });

  // Unregister all existing shortcuts before re-registering
  globalShortcut.unregisterAll();

  try {
    state.globalShortcut = state.shortcuts.list;
    state.imageShortcut = state.shortcuts.draw;
    state.videoShortcut = state.shortcuts.video;
    state.ocrShortcut = state.shortcuts.ocr;

    if (state.globalShortcut) globalShortcut.register(state.globalShortcut, showMain);
    if (state.imageShortcut) globalShortcut.register(state.imageShortcut, () => capture('draw'));
    if (state.videoShortcut) globalShortcut.register(state.videoShortcut, () => capture('video'));
    if (state.ocrShortcut) globalShortcut.register(state.ocrShortcut, () => capture('ocr'));
  } catch (err) {
    console.error('Shortcut registration failed:', err);
    showToast('Kısayol kaydedilemedi: ' + err.message, 'error');
  }

  // The store.set for globalShortcut is already handled in updateShortcut,
  // but if these are initial loads, they might need to be set here if not already.
  // Assuming state.shortcuts are loaded from store initially, so no need to set them again here.

  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: state.autoStart, path: app.getPath('exe'), args: ['--hidden'] });
  }

  // --- IPC Handlers ---
  ipcMain.handle('get-history', () => state.history);
  ipcMain.handle('get-settings', () => ({
    maxItems: state.maxItems, globalShortcut: state.shortcuts.list,
    globalShortcutImage: state.shortcuts.draw, globalShortcutVideo: state.shortcuts.video,
    globalShortcutOcr: state.shortcuts.ocr,
    autoStart: state.autoStart, videoQuality: state.videoQuality
  }));

  ipcMain.on('set-autostart', (e, v) => { state.autoStart = v; store.set('autoStart', v); });
  ipcMain.on('set-video-quality', (e, v) => { state.videoQuality = v; store.set('videoQuality', v); });
  ipcMain.on('set-shortcut', (e, s) => updateShortcut('list', s, 'globalShortcut'));
  ipcMain.on('set-image-shortcut', (e, s) => updateShortcut('draw', s, 'globalShortcutImage'));
  ipcMain.on('set-video-shortcut', (e, s) => updateShortcut('video', s, 'globalShortcutVideo'));
  ipcMain.on('set-ocr-shortcut', (e, s) => updateShortcut('ocr', s, 'globalShortcutOcr'));

  ipcMain.on('set-max-items', (e, count) => {
    state.maxItems = count;
    store.set('maxItems', count);
    if (state.history.length > count) {
      state.history = state.history.slice(0, count);
      store.set('history', state.history);
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('update-history', state.history);
      }
    }
  });

  ipcMain.on('copy-item', (e, text) => {
    clipboard.writeText(text);
    state.lastText = text;
    if (state.mainWindow) state.mainWindow.hide();
  });

  ipcMain.on('add-manual-item', (e, content) => {
    addHistory(content);
    showToast('Öğe Eklendi', 'success');
  });

  ipcMain.on('toggle-favorite', (e, id) => {
    const item = state.history.find(i => i.id === id);
    if (item) {
      item.isFavorite = !item.isFavorite;
      if (!item.isFavorite) item.hiddenFromHistory = false; // Move back to All if removed from favorites
      store.set('history', state.history);
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('update-history', state.history);
      }
    }
  });

  ipcMain.on('reorder-history', (e, newHistory) => {
    state.history = newHistory;
    store.set('history', state.history);
  });

  ipcMain.on('delete-history-item', (e, id, source) => {
    const index = state.history.findIndex(i => i.id === id);
    if (index !== -1) {
      const item = state.history[index];

      if (source === 'favorites') {
        // Deleting from favorites (X button) -> Completely delete from memory
        state.history.splice(index, 1);
      } else {
        // Deleting from History (All)
        if (item.isFavorite) {
          item.hiddenFromHistory = true;
        } else {
          state.history.splice(index, 1);
        }
      }

      store.set('history', state.history);
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('update-history', state.history);
      }
    }
  });

  ipcMain.on('clear-history', () => {
    // Keep favorites but hide them from history view
    state.history.forEach(item => {
      if (item.isFavorite) item.hiddenFromHistory = true;
    });
    // Remove items that are NOT favorites
    state.history = state.history.filter(i => i.isFavorite);

    store.set('history', state.history);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('update-history', state.history);
    }
    showToast('Geçmiş Temizlendi (Favoriler Saklandı).', 'success');
  });

  // DEBUG LOG HANDLER
  ipcMain.on('debug-log', (e, msg) => {
    console.log('[Renderer Debug]:', msg);
    // dialog.showMessageBox({ title: 'Renderer Debug', message: msg, buttons: ['OK'] });
  });

  ipcMain.on('close-window', () => { if (state.mainWindow) state.mainWindow.hide(); });
  ipcMain.on('toast-finished', () => { if (state.toastWindow && !state.toastWindow.isDestroyed()) state.toastWindow.destroy(); });

  ipcMain.on('snip-close', (e) => {
    console.log('=== IPC RECEIVED: snip-close ===');
    let win = BrowserWindow.fromWebContents(e.sender);
    // Fallback if sender lookup fails (can happen with some overlay configs)
    if (!win) {
      if (state.snipperWindow && !state.snipperWindow.isDestroyed()) win = state.snipperWindow;
      else if (state.ocrWindow && !state.ocrWindow.isDestroyed()) win = state.ocrWindow;
      else if (state.recorderWindow && !state.recorderWindow.isDestroyed()) win = state.recorderWindow;
    }

    if (win && !win.isDestroyed()) win.close();

    // Safety cleanup for all
    if (state.ocrWindow && !state.ocrWindow.isDestroyed()) state.ocrWindow.close();
    if (state.recorderWindow && !state.recorderWindow.isDestroyed()) state.recorderWindow.close();
    if (state.snipperWindow && !state.snipperWindow.isDestroyed()) state.snipperWindow.close();
  });

  ipcMain.on('snip-ready', () => {
    let win = state.snipperWindow;
    if (state.lastMode === 'ocr') win = state.ocrWindow;
    if (state.lastMode === 'video') win = state.recorderWindow;
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus(); // Force focus

      // SUPER FORCE: macOS sometimes reverts transparent windows to ignore events.
      // We force it to accept events.
      win.setIgnoreMouseEvents(false);

      if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

        // Add a safety loop to KEEP it interactive
        // (This gets cleared when window closes since it's associated with the window variable scope if we held it, 
        // but here we just fire it attached to state).
        // A cleaner way relies on the window instance.
        const focusInterval = setInterval(() => {
          if (win && !win.isDestroyed() && win.isVisible()) {
            win.setIgnoreMouseEvents(false);
            win.moveTop(); // Ensure it stays on top
          } else {
            clearInterval(focusInterval);
          }
        }, 1000);
      }
    }
  });

  // RENAMED CHANNEL: snip-copy-v2
  ipcMain.on('snip-copy-v2', (e, d) => {
    console.log('=== IPC RECEIVED: snip-copy-v2 ===', d ? d.length : 'No Data');

    // Explicitly use state window for now to rule out sender lookup issues
    let win = state.snipperWindow;

    if (win && !win.isDestroyed()) {
      try {
        const img = require('electron').nativeImage.createFromDataURL(d);
        clipboard.writeImage(img);
        console.log('Image written to clipboard');
        showToast('Resim Kopyalandı.', 'success');
      } catch (err) {
        console.error('Copy failed:', err);
        showToast('Kopyalama Hatası: ' + err.message, 'error');
      }
      // Reduced delay for faster copying
      setTimeout(() => win.close(), 100);
    } else {
      console.error('Snipper window not found or destroyed');
    }
  });

  ipcMain.on('snip-save-image', (e, d) => {
    console.log('IPC: snip-save-image received', d.length); // DEBUG
    let win = BrowserWindow.fromWebContents(e.sender);
    if (!win && state.snipperWindow && !state.snipperWindow.isDestroyed()) win = state.snipperWindow;

    // macOS: Detach dialog to prevent it being hidden/failing with alwaysOnTop windows
    // Windows: Keep parent to ensure it stays on top of the fullscreen window
    const parent = process.platform === 'darwin' ? null : win;

    // Temporarily disable alwaysOnTop on macOS to allow dialog to be seen
    if (process.platform === 'darwin' && win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false);
    }

    const p = dialog.showSaveDialogSync(parent, { title: 'Kaydet', defaultPath: path.join(app.getPath('pictures'), `snip_${Date.now()}.png`), filters: [{ name: 'Images', extensions: ['png'] }] });

    if (p) {
      fs.writeFileSync(p, Buffer.from(d.split(',')[1], 'base64'));
      showToast('Resim Kaydedildi.', 'success');
      // Only close window if save was successful
      if (win && !win.isDestroyed()) win.close();
    } else {
      // User cancelled - restore alwaysOnTop and keep window open
      if (process.platform === 'darwin' && win && !win.isDestroyed()) {
        win.setAlwaysOnTop(true, 'pop-up-menu');
      }
      showToast('Kaydetme iptal edildi.', 'info');
    }
  });


  ipcMain.on('record-start', () => { state.tempVideoPath = path.join(app.getPath('temp'), `temp_video_${Date.now()}.webm`); });
  ipcMain.on('record-chunk', (e, arrayBuffer) => { if (state.tempVideoPath) fs.appendFileSync(state.tempVideoPath, Buffer.from(arrayBuffer)); });
  ipcMain.on('record-stop', (e) => {
    const parent = process.platform === 'darwin' ? null : state.recorderWindow;
    const p = dialog.showSaveDialogSync(parent, { title: 'Videoyu Kaydet', defaultPath: path.join(app.getPath('videos'), `kayit_${Date.now()}.webm`), filters: [{ name: 'Videos', extensions: ['webm', 'mp4'] }] });

    if (p) {
      if (fs.existsSync(state.tempVideoPath)) {
        fs.copyFileSync(state.tempVideoPath, p);
        showToast('Video Kaydedildi.', 'success');
        fs.unlinkSync(state.tempVideoPath); // Only delete if saved successfully
      }
    } else {
      // Cancelled
      showToast('Kayıt iptal edildi. Geçici dosya: ' + path.basename(state.tempVideoPath), 'info');
      require('electron').shell.showItemInFolder(state.tempVideoPath); // Open folder to show file
    }

    state.tempVideoPath = null;
    if (state.recorderWindow && !state.recorderWindow.isDestroyed()) state.recorderWindow.close();
  });

  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, options);
  });

  ipcMain.on('ocr-process', async (e, d) => {
    let win = BrowserWindow.fromWebContents(e.sender);
    if (!win && state.ocrWindow && !state.ocrWindow.isDestroyed()) win = state.ocrWindow;
    if (win && !win.isDestroyed()) win.close();

    showToast('Metin Taranıyor...', 'info');
    try {
      const worker = await Tesseract.createWorker('eng+tur', 1, { load_system_dawg: '0', load_freq_dawg: '0' });
      const { data: { text } } = await worker.recognize(Buffer.from(d.split(',')[1], 'base64'));
      await worker.terminate();
      const c = text.trim();
      if (c) { state.lastText = c; clipboard.writeText(c); addHistory(c); showToast('Metin Kopyalandı.', 'success'); }
    } catch (err) { console.error(err); }
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { });
