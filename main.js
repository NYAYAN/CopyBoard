const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, screen, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const Tesseract = require('tesseract.js');

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      showMain();
    }
  });
}

const store = new Store();

const state = {
  mainWindow: null, snipperWindow: null, ocrWindow: null, tray: null,
  history: store.get('history', []),
  maxItems: store.get('maxItems', 50),
  autoStart: store.get('autoStart', true),
  shortcuts: {
    list: store.get('globalShortcut', 'Alt+Shift+V'),
    draw: store.get('globalShortcutImage', 'Alt+Shift+9'),
    ocr: 'Alt+Shift+2'
  },
  lastText: clipboard.readText(),
  lastImageCheck: null,
  lastMode: null
};

// --- Window Creators ---
function createMain() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  state.mainWindow = new BrowserWindow({
    width: 400, height: 600, x: width - 420, y: height - 620, show: false, frame: false, skipTaskbar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
    icon: path.join(__dirname, 'icon.png')
  });
  state.mainWindow.loadFile('index.html');
  state.mainWindow.on('blur', () => state.mainWindow.hide());

  // Only show if not started at login
  const isStartup = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  if (!isStartup) {
    state.mainWindow.once('ready-to-show', () => showMain());
  }
}

function createCapture(type) {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    width, height, x: 0, y: 0, show: false, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, fullscreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }
  });
  win.loadFile(type === 'ocr' ? 'ocr.html' : 'snipper.html');
  win.on('closed', () => { if (type === 'ocr') state.ocrWindow = null; else state.snipperWindow = null; });
  if (type === 'ocr') state.ocrWindow = win; else state.snipperWindow = win;
  return win;
}

function createTray() {
  state.tray = new Tray(path.join(__dirname, 'icon.png'));
  updateTrayMenu();
  state.tray.on('click', showMain);
}

function updateTrayMenu() {
  const format = (s) => s.split('+').join(' + ').replace('CommandOrControl', 'Ctrl');
  state.tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Uygulamayı Göster (${format(state.shortcuts.list)})`, click: showMain },
    { type: 'separator' },
    { label: `Ekran Görüntüsü (${format(state.shortcuts.draw)})`, click: () => capture('draw') },
    { label: `Metin Okuma (${format(state.shortcuts.ocr)})`, click: () => capture('ocr') },
    { type: 'separator' },
    { label: 'Çıkış', click: () => app.quit() }
  ]));
}

function showMain() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  state.mainWindow.setPosition(width - 420, height - 620);
  state.mainWindow.show(); state.mainWindow.focus();
}

// --- Clipboard & Logic ---
async function pollClipboard() {
  const text = clipboard.readText();
  if (text && text !== state.lastText) {
    state.lastText = text; addHistory(text); return;
  }
  const formats = clipboard.availableFormats();
  if (formats.some(f => f.includes('image')) && !text) {
    const img = clipboard.readImage();
    if (img.isEmpty()) return;
    const buf = img.toPNG();
    const sum = buf.toString('base64').substring(0, 50) + buf.length;
    if (sum !== state.lastImageCheck) {
      state.lastImageCheck = sum;
      if (state.mainWindow) state.mainWindow.webContents.send('show-toast', 'Metin taranıyor...', 'info');
      try {
        const { data: { text: res } } = await Tesseract.recognize(buf, 'eng+tur');
        const clean = res.trim();
        if (clean) { state.lastText = clean; addHistory(clean); }
      } catch (e) { console.error(e); }
    }
  }
}

function addHistory(text) {
  if (!text || !text.trim()) return;
  state.history = state.history.filter(item => (typeof item === 'string' ? item : item.content) !== text);
  state.history.unshift({ id: Date.now(), content: text, type: 'text', timestamp: new Date().toISOString() });
  if (state.history.length > state.maxItems) state.history = state.history.slice(0, state.maxItems);
  store.set('history', state.history);
  if (state.mainWindow) state.mainWindow.webContents.send('update-history', state.history);
}

// --- Shortcuts ---
function updateShortcut(key, val, storeKey) {
  globalShortcut.unregister(state.shortcuts[key]);
  if (globalShortcut.register(val, key === 'list' ? showMain : () => capture(key))) {
    state.shortcuts[key] = val; store.set(storeKey, val);
    updateTrayMenu();
  } else globalShortcut.register(state.shortcuts[key], key === 'list' ? showMain : () => capture(key));
}

async function capture(mode) {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    if (sources[0]) {
      const data = sources[0].thumbnail.toDataURL();
      state.lastMode = mode;
      const win = createCapture(mode);
      win.webContents.on('did-finish-load', () => win.webContents.send('capture-screen', data, mode));
    }
  } catch (e) { console.error(e); }
}

// --- Initialization ---
app.whenReady().then(() => {
  createTray(); createMain();
  setInterval(pollClipboard, 1000);

  globalShortcut.register(state.shortcuts.list, showMain);
  globalShortcut.register(state.shortcuts.draw, () => capture('draw'));
  globalShortcut.register(state.shortcuts.ocr, () => capture('ocr'));

  if (app.isPackaged) {
    // CLEAN LEGACY DEPRECATED KEYS (Cleanup for dev leftovers)
    app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, name: 'electron.app.CopyBoard' });
    app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, name: 'CopyBoard' });

    // SET FRESH PRODUCTION KEY
    app.setLoginItemSettings({
      openAtLogin: state.autoStart,
      path: app.getPath('exe'),
      args: ['--hidden']
    });
  }

  ipcMain.handle('get-history', () => state.history);
  ipcMain.handle('get-settings', () => ({
    maxItems: state.maxItems,
    globalShortcut: state.shortcuts.list,
    globalShortcutImage: state.shortcuts.draw,
    autoStart: state.autoStart
  }));

  ipcMain.on('set-autostart', (e, val) => {
    state.autoStart = val;
    store.set('autoStart', val);

    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: val,
        path: app.getPath('exe'),
        args: ['--hidden']
      });
    }
  });

  ipcMain.on('set-shortcut', (e, s) => updateShortcut('list', s, 'globalShortcut'));
  ipcMain.on('set-image-shortcut', (e, s) => updateShortcut('draw', s, 'globalShortcutImage'));
  ipcMain.on('set-max-items', (e, c) => {
    state.maxItems = c; store.set('maxItems', c);
    if (state.history.length > c) {
      state.history = state.history.slice(0, c);
      store.set('history', state.history);
      state.mainWindow.webContents.send('update-history', state.history);
    }
  });

  ipcMain.on('copy-item', (e, i) => {
    const t = typeof i === 'string' ? i : i.content;
    if (t) { clipboard.writeText(t); state.lastText = t; }
    state.mainWindow.hide();
  });

  ipcMain.on('clear-history', () => {
    state.history = []; store.set('history', []);
    state.mainWindow.webContents.send('update-history', []);
  });

  ipcMain.on('close-window', () => state.mainWindow.hide());
  ipcMain.on('snip-close', () => { if (state.snipperWindow) state.snipperWindow.close(); if (state.ocrWindow) state.ocrWindow.close(); });
  ipcMain.on('snip-ready', () => { const win = state.lastMode === 'ocr' ? state.ocrWindow : state.snipperWindow; if (win) { win.show(); win.focus(); } });
  ipcMain.on('snip-copy-image', (e, d) => { clipboard.writeImage(require('electron').nativeImage.createFromDataURL(d)); state.mainWindow.webContents.send('show-toast', 'Kopyalandı.', 'success'); state.snipperWindow.close(); });
  ipcMain.on('snip-save-image', (e, d) => {
    const p = dialog.showSaveDialogSync(state.snipperWindow, { title: 'Kaydet', defaultPath: path.join(app.getPath('pictures'), `snip_${Date.now()}.png`), filters: [{ name: 'Images', extensions: ['png'] }] });
    if (p) { fs.writeFileSync(p, Buffer.from(d.split(',')[1], 'base64')); state.mainWindow.webContents.send('show-toast', 'Kaydedildi.', 'success'); state.snipperWindow.close(); }
  });

  ipcMain.on('snip-complete', async (e, d) => {
    if (state.snipperWindow) state.snipperWindow.close(); if (state.ocrWindow) state.ocrWindow.close();
    state.mainWindow.show(); state.mainWindow.webContents.send('show-toast', 'Taranıyor...', 'info');
    try {
      const { data: { text } } = await Tesseract.recognize(Buffer.from(d.split(',')[1], 'base64'), 'eng+tur');
      const c = text.trim();
      if (c) {
        state.lastText = c; clipboard.writeText(c); addHistory(c);
        state.mainWindow.webContents.send('show-toast', 'Kopyalandı.', 'success');
      }
    } catch (err) { console.error(err); }
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { });
