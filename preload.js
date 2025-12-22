const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getHistory: () => ipcRenderer.invoke('get-history'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setMaxItems: (count) => ipcRenderer.send('set-max-items', count),
    setShortcut: (shortcut) => ipcRenderer.send('set-shortcut', shortcut),
    setImageShortcut: (shortcut) => ipcRenderer.send('set-image-shortcut', shortcut),
    setVideoShortcut: (shortcut) => ipcRenderer.send('set-video-shortcut', shortcut),
    copyItem: (text) => ipcRenderer.send('copy-item', text),
    deleteHistoryItem: (content) => ipcRenderer.send('delete-history-item', content),
    clearHistory: () => ipcRenderer.send('clear-history'),
    closeWindow: () => ipcRenderer.send('close-window'),
    setAutoStart: (val) => ipcRenderer.send('set-autostart', val),
    setVideoQuality: (val) => ipcRenderer.send('set-video-quality', val),
    setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
    onUpdateHistory: (callback) => ipcRenderer.on('update-history', (_, value) => callback(value)),

    // Snipper & OCR & Recorder
    onCaptureScreen: (callback) => ipcRenderer.on('capture-screen', (_, data, mode, sourceId, quality) => callback(data, mode, sourceId, quality)),
    sendOCR: (dataUrl) => ipcRenderer.send('ocr-process', dataUrl),
    sendCopyImage: (dataUrl) => ipcRenderer.send('snip-copy-image', dataUrl),
    sendSaveImage: (dataUrl) => ipcRenderer.send('snip-save-image', dataUrl),
    recordStart: () => ipcRenderer.send('record-start'),
    recordChunk: (buffer) => ipcRenderer.send('record-chunk', buffer),
    recordStop: () => ipcRenderer.send('record-stop'),
    closeSnipper: () => ipcRenderer.send('snip-close'),
    notifyReady: () => ipcRenderer.send('snip-ready'),
    onShowToast: (callback) => ipcRenderer.on('show-toast', (_, message, type) => callback(message, type))
});
