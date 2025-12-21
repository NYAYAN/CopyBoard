const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, clipboard, screen, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const Tesseract = require('tesseract.js');

const store = new Store();

const state = {
  mainWindow: null,
  snipperWindow: null,
  ocrWindow: null,
  recorderWindow: null,
  toastWindow: null,
  history: store.get('history', []),
  maxItems: store.get('maxItems', 50),
  autoStart: store.get('autoStart', true),
  videoQuality: store.get('videoQuality', 'high'),
  shortcuts: {
    list: store.get('globalShortcut', 'Alt+Shift+V'),
    draw: store.get('globalShortcutImage', 'Alt+Shift+9'),
    video: store.get('globalShortcutVideo', 'Alt+Shift+8'),
    ocr: 'Alt+Shift+2'
  },
  lastText: '',
  lastMode: 'draw',
  tempVideoPath: null
};

// --- Gelişmiş Bildirim (Toast) Sistemi ---
function showToast(message, type = 'info') {
  try {
    if (state.toastWindow && !state.toastWindow.isDestroyed()) {
      state.toastWindow.destroy();
    }

    const display = screen.getPrimaryDisplay();
    const { width } = display.workAreaSize;

    state.toastWindow = new BrowserWindow({
      width: 350, height: 100, x: width - 370, y: 50,
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

ipcMain.on('toast-finished', () => {
  if (state.toastWindow && !state.toastWindow.isDestroyed()) state.toastWindow.destroy();
});

function addHistory(content) {
  if (!content || state.history.some(i => i.content === content)) return;
  state.history.unshift({ content, timestamp: new Date().toISOString() });
  if (state.history.length > state.maxItems) state.history = state.history.slice(0, state.maxItems);
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
    // Main pencereyi video kaydının da üstüne çıkarmak için 'screen-saver' seviyesine yükseltiyoruz
    state.mainWindow.setAlwaysOnTop(true, 'screen-saver');
    // Sağ alt köşede aç (Saat ve system tray yanında)
    state.mainWindow.setPosition(
      display.workArea.x + width - 420,
      display.workArea.y + height - 620
    );
    state.mainWindow.show();
    state.mainWindow.focus();
  }
}

function createCapture(type = 'draw') {
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true,
    fullscreen: true, skipTaskbar: true, movable: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });

  let file = 'snipper.html';
  if (type === 'ocr') file = 'ocr.html';
  if (type === 'video') file = 'recorder.html';

  win.loadFile(path.join(__dirname, file));

  // Tüm capture pencereleri en üstte (Video toolbar her zaman görünür)
  win.setAlwaysOnTop(true, 'screen-saver');

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
    const { width, height } = screen.getPrimaryDisplay().bounds;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    if (sources[0]) {
      const data = sources[0].thumbnail.toDataURL();
      const sourceId = sources[0].id;
      state.lastMode = mode;
      const win = createCapture(mode);
      win.webContents.on('did-finish-load', () => {
        if (!win.isDestroyed()) win.webContents.send('capture-screen', data, mode, sourceId, state.videoQuality);
      });
    }
  } catch (e) { console.error(e); }
}

app.whenReady().then(() => {
  const tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('CopyBoard');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Göster', click: showMain }, { label: 'Çıkış', click: () => app.quit() }]));
  tray.on('click', showMain);

  state.mainWindow = new BrowserWindow({
    width: 400, height: 600, frame: false, show: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }
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

  ipcMain.handle('get-history', () => state.history);
  ipcMain.handle('get-settings', () => ({
    maxItems: state.maxItems, globalShortcut: state.shortcuts.list,
    globalShortcutImage: state.shortcuts.draw, globalShortcutVideo: state.shortcuts.video,
    autoStart: state.autoStart, videoQuality: state.videoQuality
  }));

  ipcMain.on('set-autostart', (e, v) => { state.autoStart = v; store.set('autoStart', v); });
  ipcMain.on('set-video-quality', (e, v) => { state.videoQuality = v; store.set('videoQuality', v); });
  ipcMain.on('set-shortcut', (e, s) => updateShortcut('list', s, 'globalShortcut'));
  ipcMain.on('set-image-shortcut', (e, s) => updateShortcut('draw', s, 'globalShortcutImage'));
  ipcMain.on('set-video-shortcut', (e, s) => updateShortcut('video', s, 'globalShortcutVideo'));
  ipcMain.on('close-window', () => { if (state.mainWindow) state.mainWindow.hide(); });
  ipcMain.on('snip-close', () => { [state.snipperWindow, state.ocrWindow, state.recorderWindow].forEach(w => w && !w.isDestroyed() && w.close()); });

  ipcMain.on('snip-ready', () => {
    let win = state.snipperWindow;
    if (state.lastMode === 'ocr') win = state.ocrWindow;
    if (state.lastMode === 'video') win = state.recorderWindow;
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  });

  ipcMain.on('snip-copy-image', (e, d) => {
    clipboard.writeImage(require('electron').nativeImage.createFromDataURL(d));
    showToast('Resim Kopyalandı.', 'success');
    if (state.snipperWindow) state.snipperWindow.close();
  });

  ipcMain.on('snip-save-image', (e, d) => {
    const p = dialog.showSaveDialogSync(state.snipperWindow, { title: 'Kaydet', defaultPath: path.join(app.getPath('pictures'), `snip_${Date.now()}.png`), filters: [{ name: 'Images', extensions: ['png'] }] });
    if (p) { fs.writeFileSync(p, Buffer.from(d.split(',')[1], 'base64')); showToast('Resim Kaydedildi.', 'success'); }
    if (state.snipperWindow) state.snipperWindow.close();
  });

  ipcMain.on('record-start', () => { state.tempVideoPath = path.join(app.getPath('temp'), `temp_video_${Date.now()}.webm`); });
  ipcMain.on('record-chunk', (e, arrayBuffer) => { if (state.tempVideoPath) fs.appendFileSync(state.tempVideoPath, Buffer.from(arrayBuffer)); });
  ipcMain.on('record-stop', (e) => {
    const p = dialog.showSaveDialogSync(state.recorderWindow, { title: 'Videoyu Kaydet', defaultPath: path.join(app.getPath('videos'), `kayit_${Date.now()}.webm`), filters: [{ name: 'Videos', extensions: ['webm', 'mp4'] }] });
    if (p) { fs.copyFileSync(state.tempVideoPath, p); showToast('Video Kaydedildi.', 'success'); }
    if (fs.existsSync(state.tempVideoPath)) fs.unlinkSync(state.tempVideoPath);
    state.tempVideoPath = null;
    if (state.recorderWindow) state.recorderWindow.close();
  });

  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, options);
  });

  ipcMain.on('ocr-process', async (e, d) => {
    if (state.ocrWindow) state.ocrWindow.close(); // Sadece OCR penceresi ile ilgilenir
    showToast('Metin Taranıyor...', 'info');
    try {
      // Worker'ı başlat (Sözlük parametreleri initialize sırasında!)
      const worker = await Tesseract.createWorker('eng+tur', 1, {
        load_system_dawg: '0',
        load_freq_dawg: '0'
      });

      const { data: { text } } = await worker.recognize(Buffer.from(d.split(',')[1], 'base64'));
      await worker.terminate();

      const c = text.trim();
      if (c) { state.lastText = c; clipboard.writeText(c); addHistory(c); showToast('Metin Kopyalandı.', 'success'); }
    } catch (err) { console.error(err); }
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { });
