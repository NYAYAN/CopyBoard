const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getHistory: () => ipcRenderer.invoke('get-history'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setMaxItems: (count) => ipcRenderer.send('set-max-items', count),
    setShortcut: (shortcut) => ipcRenderer.send('set-shortcut', shortcut),
    setImageShortcut: (shortcut) => ipcRenderer.send('set-image-shortcut', shortcut),
    setVideoShortcut: (shortcut) => ipcRenderer.send('set-video-shortcut', shortcut),
    setOcrShortcut: (shortcut) => ipcRenderer.send('set-ocr-shortcut', shortcut),
    copyItem: (text) => ipcRenderer.send('copy-item', text),
    deleteHistoryItem: (content, source) => ipcRenderer.send('delete-history-item', content, source),
    toggleFavorite: (id) => ipcRenderer.send('toggle-favorite', id),
    addManualItem: (content) => ipcRenderer.send('add-manual-item', content),
    reorderHistory: (history) => ipcRenderer.send('reorder-history', history),
    clearHistory: () => ipcRenderer.send('clear-history'),
    closeWindow: () => ipcRenderer.send('close-window'),
    setAutoStart: (val) => ipcRenderer.send('set-autostart', val),
    setVideoQuality: (val) => ipcRenderer.send('set-video-quality', val),
    setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
    onUpdateHistory: (callback) => ipcRenderer.on('update-history', (_, value) => callback(value)),

    // Snipper & OCR & Recorder
    onCaptureScreen: (callback) => ipcRenderer.on('capture-screen', (_, data, mode, sourceId, quality) => callback(data, mode, sourceId, quality)),
    sendOCR: (dataUrl) => ipcRenderer.send('ocr-process', dataUrl),
    sendCopyImage: (dataUrl) => ipcRenderer.send('snip-copy-v2', dataUrl), // RENAMED due to channel blocking
    sendSaveImage: (dataUrl) => ipcRenderer.send('snip-save-image', dataUrl),
    recordStart: () => ipcRenderer.send('record-start'),
    recordChunk: (buffer) => ipcRenderer.send('record-chunk', buffer),
    recordStop: () => ipcRenderer.send('record-stop'),
    closeSnipper: () => ipcRenderer.send('snip-close'),
    notifyReady: () => ipcRenderer.send('snip-ready'),
    onShowToast: (callback) => ipcRenderer.on('show-toast', (_, message, type) => callback(message, type)),
    onResetView: (callback) => ipcRenderer.on('reset-view', callback),
    sendDebugLog: (msg) => ipcRenderer.send('debug-log', msg), // NEW DEBUG CHANNEL

    // Auto-Update
    checkForUpdates: () => ipcRenderer.send('check-for-updates'),
    downloadUpdate: () => ipcRenderer.send('download-update'),
    installUpdate: () => ipcRenderer.send('install-update'),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_, info) => callback(info)),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (_, info) => callback(info)),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_, progress) => callback(progress))
});
