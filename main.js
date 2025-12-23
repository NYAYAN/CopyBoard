const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, clipboard, screen, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const Tesseract = require('tesseract.js');
const crypto = require('crypto');

const store = new Store();

// --- Migration ---
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
  tempVideoPath: null
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
  }
}

function createCapture(type = 'draw', display = null) {
  if (!display) display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true,
    fullscreen: true, skipTaskbar: true, movable: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }
  });

  let file = 'snipper.html';
  if (type === 'ocr') file = 'ocr.html';
  if (type === 'video') file = 'recorder.html';

  win.loadFile(path.join(__dirname, file));
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => { return { action: 'deny' }; });

  win.on('closed', () => {
    if (type === 'ocr') state.ocrWindow = null;
    else if (type === 'video') state.recorderWindow = null;
    else state.snipperWindow = null;
  });

  if (type === 'ocr') state.ocrWindow = win;
  else if (type === 'video') state.recorderWindow = win;
  else state.snipperWindow = win;

  return win;
}

async function capture(mode) {
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
    }
  } catch (e) { showToast('Capture Hatası', 'error'); console.error(e); }
}

app.whenReady().then(() => {
  const tray = new Tray(path.join(__dirname, 'icon.png'));
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }
  });

  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  state.mainWindow.loadFile('index.html');
  state.mainWindow.on('blur', () => state.mainWindow.hide());

  setInterval(() => {
    const t = clipboard.readText();
    if (t && t !== state.lastText) { state.lastText = t; addHistory(t); }
  }, 1000);

  globalShortcut.register(state.shortcuts.list, showMain);
  globalShortcut.register(state.shortcuts.draw, () => capture('draw'));
  globalShortcut.register(state.shortcuts.video, () => capture('video'));
  globalShortcut.register(state.shortcuts.ocr, () => capture('ocr'));

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
  });

  ipcMain.on('add-manual-item', (e, content) => {
    addHistory(content);
    showToast('Öğe Eklendi', 'success');
  });

  ipcMain.on('toggle-favorite', (e, id) => {
    const item = state.history.find(i => i.id === id);
    if (item) {
      item.isFavorite = !item.isFavorite;
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

  ipcMain.on('delete-history-item', (e, id) => {
    state.history = state.history.filter(i => i.id !== id);
    store.set('history', state.history);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('update-history', state.history);
    }
  });

  ipcMain.on('clear-history', () => {
    state.history = [];
    store.set('history', []);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('update-history', state.history);
    }
    showToast('Geçmiş Temizlendi.', 'success');
  });

  ipcMain.on('close-window', () => { if (state.mainWindow) state.mainWindow.hide(); });
  ipcMain.on('toast-finished', () => { if (state.toastWindow && !state.toastWindow.isDestroyed()) state.toastWindow.destroy(); });

  ipcMain.on('snip-close', () => { [state.snipperWindow, state.ocrWindow, state.recorderWindow].forEach(w => w && !w.isDestroyed() && w.close()); });

  ipcMain.on('snip-ready', () => {
    let win = state.snipperWindow;
    if (state.lastMode === 'ocr') win = state.ocrWindow;
    if (state.lastMode === 'video') win = state.recorderWindow;
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  });

  ipcMain.on('snip-copy-image', (e, d) => {
    if (state.snipperWindow && !state.snipperWindow.isDestroyed()) {
      clipboard.writeImage(require('electron').nativeImage.createFromDataURL(d));
      showToast('Resim Kopyalandı.', 'success');
      state.snipperWindow.close();
    }
  });

  ipcMain.on('snip-save-image', (e, d) => {
    const p = dialog.showSaveDialogSync(state.snipperWindow, { title: 'Kaydet', defaultPath: path.join(app.getPath('pictures'), `snip_${Date.now()}.png`), filters: [{ name: 'Images', extensions: ['png'] }] });
    if (p) { fs.writeFileSync(p, Buffer.from(d.split(',')[1], 'base64')); showToast('Resim Kaydedildi.', 'success'); }
    if (state.snipperWindow && !state.snipperWindow.isDestroyed()) state.snipperWindow.close();
  });

  ipcMain.on('record-start', () => { state.tempVideoPath = path.join(app.getPath('temp'), `temp_video_${Date.now()}.webm`); });
  ipcMain.on('record-chunk', (e, arrayBuffer) => { if (state.tempVideoPath) fs.appendFileSync(state.tempVideoPath, Buffer.from(arrayBuffer)); });
  ipcMain.on('record-stop', (e) => {
    const p = dialog.showSaveDialogSync(state.recorderWindow, { title: 'Videoyu Kaydet', defaultPath: path.join(app.getPath('videos'), `kayit_${Date.now()}.webm`), filters: [{ name: 'Videos', extensions: ['webm', 'mp4'] }] });
    if (p) { if (fs.existsSync(state.tempVideoPath)) fs.copyFileSync(state.tempVideoPath, p); showToast('Video Kaydedildi.', 'success'); }
    if (state.tempVideoPath && fs.existsSync(state.tempVideoPath)) fs.unlinkSync(state.tempVideoPath);
    state.tempVideoPath = null;
    if (state.recorderWindow && !state.recorderWindow.isDestroyed()) state.recorderWindow.close();
  });

  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, options);
  });

  ipcMain.on('ocr-process', async (e, d) => {
    if (state.ocrWindow && !state.ocrWindow.isDestroyed()) state.ocrWindow.close();
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
