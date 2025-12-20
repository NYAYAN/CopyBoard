const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getHistory: () => ipcRenderer.invoke('get-history'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setMaxItems: (count) => ipcRenderer.send('set-max-items', count),
    setShortcut: (shortcut) => ipcRenderer.send('set-shortcut', shortcut),
    setImageShortcut: (shortcut) => ipcRenderer.send('set-image-shortcut', shortcut),
    copyItem: (text) => ipcRenderer.send('copy-item', text),
    clearHistory: () => ipcRenderer.send('clear-history'),
    closeWindow: () => ipcRenderer.send('close-window'),
    setAutoStart: (val) => ipcRenderer.send('set-autostart', val),
    onUpdateHistory: (callback) => ipcRenderer.on('update-history', (_, value) => callback(value)),

    // Snipper
    onCaptureScreen: (callback) => ipcRenderer.on('capture-screen', (_, data, mode) => callback(data, mode)),
    sendCrop: (dataUrl) => ipcRenderer.send('snip-complete', dataUrl),
    sendCopyImage: (dataUrl) => ipcRenderer.send('snip-copy-image', dataUrl),
    sendSaveImage: (dataUrl) => ipcRenderer.send('snip-save-image', dataUrl),
    closeSnipper: () => ipcRenderer.send('snip-close'),
    notifyReady: () => ipcRenderer.send('snip-ready'),
    onShowToast: (callback) => ipcRenderer.on('show-toast', (_, message, type) => callback(message, type))
});
