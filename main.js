const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, screen, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const Tesseract = require('tesseract.js');

const store = new Store();
let mainWindow;
let snipperWindow;
let ocrWindow;
let tray;
let clipboardHistory = store.get('history', []);
let maxItems = store.get('maxItems', 50);
let globalShortcutKey = store.get('globalShortcut', 'Alt+Shift+V');
let globalShortcutImage = store.get('globalShortcutImage', 'Alt+Shift+9');
let pendingMode = null; // Track which window to show on ready

// Fix conflict: If user still has Alt+Shift+2 stored for Draw mode, force reset it to Alt+Shift+9
if (globalShortcutImage === 'Alt+Shift+2') {
  globalShortcutImage = 'Alt+Shift+9';
  store.set('globalShortcutImage', 'Alt+Shift+9');
}

let lastText = clipboard.readText();
const LAST_IMAGE_KEY = 'lastImageHash'; // Simple in-memory check for now
let lastImageCheck = null;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    x: width - 420,
    y: height - 620,
    show: false,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'icon.png')
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('blur', () => {
    mainWindow.hide();
  });

  createSnipperWindow();
  createOCRWindow();
}

function createSnipperWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds; // Use bounds for full coverage

  snipperWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    transparent: true, // Crucial for overlay feel
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  snipperWindow.loadFile('snipper.html');
}

function createOCRWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  ocrWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  ocrWindow.loadFile('ocr.html');
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Göster', click: () => showWindow() },
    { label: 'Çıkış', click: () => app.quit() }
  ]);

  tray.setToolTip('CopyBoard');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    showWindow();
  });
}

function showWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  // Position window near tray (bottom right usually on Windows)
  // Re-calculate simply to be safe
  mainWindow.setPosition(width - 420, height - 620);
  mainWindow.show();
  mainWindow.focus();
}

async function checkClipboard() {
  // 1. Text Check
  const text = clipboard.readText();
  if (text && text !== lastText) {
    lastText = text;
    addHistoryItem(text);
    return; // Priority to text
  }

  // 2. Image Check (OCR)
  const formats = clipboard.availableFormats();
  const hasImage = formats.some(f => f.includes('image'));

  if (hasImage && !text) { // Only check image if no text implies direct text copy
    try {
      const image = clipboard.readImage();
      if (image.isEmpty()) return;

      const imageBuffer = image.toPNG();
      const currentImageCheck = imageBuffer.toString('base64').substring(0, 50) + imageBuffer.length;

      if (currentImageCheck !== lastImageCheck) {
        lastImageCheck = currentImageCheck;

        // Notify user analysis started (Optional - kept silent or custom toast)
        if (mainWindow) mainWindow.webContents.send('show-toast', 'Metin taranıyor...', 'info');

        const { data: { text: recognizedText } } = await Tesseract.recognize(imageBuffer, 'eng+tur');

        const cleanText = recognizedText.trim();
        if (cleanText) {
          lastText = cleanText;
          addHistoryItem(cleanText);
          if (mainWindow) mainWindow.webContents.send('show-toast', 'Görseldeki yazı eklendi.', 'success');
        } else {
          if (mainWindow) mainWindow.webContents.send('show-toast', 'Yazı bulunamadı.', 'error');
        }
      }
    } catch (error) {
      console.error('OCR Error:', error);
    }
  }
}

function addHistoryItem(text) {
  // Remove if exists to move to top
  clipboardHistory = clipboardHistory.filter(item => item !== text);
  clipboardHistory.unshift(text);

  if (clipboardHistory.length > maxItems) {
    clipboardHistory = clipboardHistory.slice(0, maxItems);
  }

  store.set('history', clipboardHistory);
  if (mainWindow) {
    mainWindow.webContents.send('update-history', clipboardHistory);
  }
}

let lastMode = null; // To know which window to show

app.whenReady().then(() => {
  createTray();
  createWindow();

  // Polling clipboard every 1 second
  setInterval(checkClipboard, 1000);

  // 1. History List Shortcut 
  registerGlobalShortcut(globalShortcutKey);

  // 2. OCR Selection Shortcut
  registerImageShortcut(globalShortcutImage);

  // Separate registration for OCR shortcut (Alt+Shift+2 - Hardcoded)
  // We unregister it first to be sure
  if (globalShortcut.isRegistered('Alt+Shift+2')) {
    globalShortcut.unregister('Alt+Shift+2');
  }

  globalShortcut.register('Alt+Shift+2', async () => {
    console.log('OCR Shortcut Triggered (Alt+Shift+2)');
    captureAndOpenSnipper('ocr');
  });

  // Snipper IPC
  ipcMain.on('snip-close', () => {
    snipperWindow.hide();
    ocrWindow.hide();
  });

  ipcMain.on('snip-ready', (event) => {
    if (lastMode === 'ocr') {
      ocrWindow.show();
      ocrWindow.focus();
    } else {
      snipperWindow.show();
      snipperWindow.focus();
    }
  });

  ipcMain.on('snip-copy-image', (event, dataUrl) => {
    try {
      const { nativeImage } = require('electron');
      const image = nativeImage.createFromDataURL(dataUrl);
      clipboard.writeImage(image);
      if (mainWindow) mainWindow.webContents.send('show-toast', 'Resim kopyalandı.', 'success');
      // User might want to keep editing? Normally copy means "I'm done".
      // Let's keep it open for consistency with drawing tools, OR close?
      // Lightshot closes after copy. We'll close.
      snipperWindow.hide();
    } catch (e) {
      console.error(e);
      if (mainWindow) mainWindow.webContents.send('show-toast', 'Kopyalama hatası.', 'error');
    }
  });

  ipcMain.on('snip-save-image', async (event, dataUrl) => {
    try {
      const { filePath } = await dialog.showSaveDialog(snipperWindow, {
        title: 'Ekran Görüntüsünü Kaydet',
        defaultPath: path.join(app.getPath('pictures'), `screenshot_${Date.now()}.png`),
        filters: [{ name: 'Images', extensions: ['png', 'jpg'] }]
      });

      if (filePath) {
        const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
        fs.writeFile(filePath, buffer, (err) => {
          if (err) {
            console.error(err);
            if (mainWindow) mainWindow.webContents.send('show-toast', 'Kaydetme başarısız.', 'error');
          } else {
            if (mainWindow) mainWindow.webContents.send('show-toast', 'Resim kaydedildi.', 'success');
            // Close window on successful save (User request)
            snipperWindow.hide();
          }
        });
      }
      // If canceled, do nothing (window stays open)
    } catch (e) {
      console.error(e);
    }
  });

  ipcMain.on('snip-complete', async (event, dataUrl) => {
    snipperWindow.hide();
    ocrWindow.hide();

    // Notify processing
    if (mainWindow) mainWindow.webContents.send('show-toast', 'Metin taranıyor...', 'info');

    try {
      // dataUrl is "data:image/png;base64,..."
      const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');

      const { data: { text: recognizedText } } = await Tesseract.recognize(buffer, 'eng+tur');
      const cleanText = recognizedText.trim();

      if (cleanText) {
        lastText = cleanText;
        addHistoryItem(cleanText);
        clipboard.writeText(cleanText); // Auto copy to clipboard
        if (mainWindow) mainWindow.webContents.send('show-toast', 'Metin kopyalandı.', 'success');
      } else {
        if (mainWindow) mainWindow.webContents.send('show-toast', 'Okunabilir metin yok.', 'error');
      }
    } catch (error) {
      console.error('OCR Error', error);
      if (mainWindow) mainWindow.webContents.send('show-toast', 'Hata: Metin okunamadı.', 'error');
    }
  });

  // Initial load
  ipcMain.handle('get-history', () => clipboardHistory);
  ipcMain.handle('get-settings', () => ({ maxItems, globalShortcut: globalShortcutKey }));

  ipcMain.on('set-shortcut', (event, shortcut) => {
    globalShortcut.unregisterAll();
    if (registerGlobalShortcut(shortcut)) {
      globalShortcutKey = shortcut;
      store.set('globalShortcut', globalShortcutKey);
    } else {
      // Revert if failed (optional handling)
      console.log('Failed to register new shortcut');
      registerGlobalShortcut(globalShortcutKey);
    }
  });

  ipcMain.on('set-max-items', (event, count) => {
    maxItems = count;
    store.set('maxItems', maxItems);
    // Trim current history if needed
    if (clipboardHistory.length > maxItems) {
      clipboardHistory = clipboardHistory.slice(0, maxItems);
      store.set('history', clipboardHistory);
      mainWindow.webContents.send('update-history', clipboardHistory);
    }
  });

  ipcMain.on('copy-item', (event, text) => {
    clipboard.writeText(text);
    lastText = text; // Prevent re-adding immediately
    mainWindow.hide();
  });

  ipcMain.on('clear-history', () => {
    clipboardHistory = [];
    store.set('history', []);
    mainWindow.webContents.send('update-history', []);
  });

  ipcMain.on('close-window', () => {
    mainWindow.hide();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Do nothing, keep running in tray
});

function registerGlobalShortcut(shortcut) {
  try {
    const ret = globalShortcut.register(shortcut, () => {
      // Check if it's the OCR shortcut (Alt+Shift+2) or Toolbar shortcut (Alt+Shift+9)
      // Actually this function is for the HISTORY list only in previous code logic?
      // Wait, globalShortcutKey is for list.
      showWindow();
    });
    if (!ret) {
      console.log('History Registration failed: ' + shortcut);
    }
    return ret;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function registerImageShortcut(shortcut) {
  // This is specifically for Alt+Shift+9 (Drawing Mode)
  try {
    const ret = globalShortcut.register(shortcut, async () => {
      captureAndOpenSnipper('draw');
    });

    if (!ret) {
      console.log('Image Registration failed: ' + shortcut);
    }
    return ret;
  } catch (e) {
    console.error(e);
    return false;
  }
}

async function captureAndOpenSnipper(mode) {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const primarySource = sources[0];

    if (primarySource) {
      const dataUrl = primarySource.thumbnail.toDataURL();
      lastMode = mode;
      if (mode === 'ocr') {
        ocrWindow.webContents.send('capture-screen', dataUrl, mode);
      } else {
        snipperWindow.webContents.send('capture-screen', dataUrl, mode);
      }
    }
  } catch (e) {
    console.error('Screen capture failed', e);
  }
}
