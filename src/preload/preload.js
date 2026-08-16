const { contextBridge, ipcRenderer } = require('electron');

// Fetched synchronously so the dictionary is in hand before the page's own scripts run
// (shared/i18n.js translates the markup in its first pass). A sandboxed preload can't
// read the JSON itself, hence the round trip; the payload is a few KB of strings.
let i18n = { lang: 'tr', dict: {} };
let theme = { mode: 'dark', resolved: 'dark' };
try { i18n = ipcRenderer.sendSync('i18n-get') || i18n; } catch (e) { /* main not ready — stay Turkish */ }
try { theme = ipcRenderer.sendSync('theme-get') || theme; } catch (e) { /* stay dark */ }

contextBridge.exposeInMainWorld('api', {
    platform: process.platform,
    i18n,
    setLanguage: (lang) => ipcRenderer.send('set-language', lang),
    theme,
    setTheme: (value) => ipcRenderer.send('set-theme', value),
    onThemeChanged: (cb) => ipcRenderer.on('theme-changed', (_, value) => cb(value)),
    getHistory: () => ipcRenderer.invoke('get-history'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    getAudioSettings: () => ipcRenderer.invoke('get-audio-settings'),
    ensureMicPermission: () => ipcRenderer.invoke('ensure-mic-permission'),
    setMaxItems: (count) => ipcRenderer.send('set-max-items', count),
    setQuickPasteCount: (count) => ipcRenderer.send('set-quickpaste-count', count),
    setShortcut: (shortcut) => ipcRenderer.send('set-shortcut', shortcut),
    setImageShortcut: (shortcut) => ipcRenderer.send('set-image-shortcut', shortcut),
    setVideoShortcut: (shortcut) => ipcRenderer.send('set-video-shortcut', shortcut),
    setOcrShortcut: (shortcut) => ipcRenderer.send('set-ocr-shortcut', shortcut),
    setColorShortcut: (shortcut) => ipcRenderer.send('set-color-shortcut', shortcut),
    setShortcutEnabled: (key, enabled) => ipcRenderer.send('set-shortcut-enabled', key, enabled),
    setPasteShortcut: (shortcut) => ipcRenderer.send('set-paste-shortcut', shortcut),
    copyItem: (text) => ipcRenderer.send('copy-item', text),
    copyText: (text) => ipcRenderer.send('copy-text', text), // copy without dismissing the window
    deleteHistoryItem: (id) => ipcRenderer.send('delete-history-item', id),
    addToFavorites: (item) => ipcRenderer.send('add-to-favorites', item),
    removeFromFavorites: (id) => ipcRenderer.send('remove-from-favorites', id),
    setItemNote: (id, note) => ipcRenderer.send('set-item-note', id, note),
    reorderHistory: (history) => ipcRenderer.send('reorder-history', history),
    reorderFavorites: (favorites) => ipcRenderer.send('reorder-favorites', favorites),
    clearHistory: () => ipcRenderer.send('clear-history'),
    closeWindow: () => ipcRenderer.send('close-window'),
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    toastFinished: () => ipcRenderer.send('toast-finished'),
    toastResize: (height) => ipcRenderer.send('toast-resize', height), // fit the window to the message
    openExternal: (url) => ipcRenderer.send('open-url', url),
    setAutoStart: (val) => ipcRenderer.send('set-autostart', val),
    setClipboardPaused: (val) => ipcRenderer.send('set-clipboard-paused', val),
    setVideoQuality: (val) => ipcRenderer.send('set-video-quality', val),
    setAudioMic: (val) => ipcRenderer.send('set-audio-mic', val),
    setAudioSystem: (val) => ipcRenderer.send('set-audio-system', val),
    setShowWidget: (show) => ipcRenderer.send('set-show-widget', show),
    setWidgetTransparent: (val) => ipcRenderer.send('set-widget-transparent', val),
    setWidgetColor: (val) => ipcRenderer.send('set-widget-color', val),
    setWidgetOpacity: (val) => ipcRenderer.send('set-widget-opacity', parseInt(val)),
    setWidgetScale: (val) => ipcRenderer.send('set-widget-scale', parseInt(val)),
    setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
    onUpdateHistory: (callback) => ipcRenderer.on('update-history', (_, value) => callback(value)),

    // Snipper & OCR & Recorder
    onCaptureScreen: (callback) => ipcRenderer.on('capture-screen', (_, data, mode, sourceId, quality, captureWidth, captureHeight, multiMonitor) => callback(data, mode, sourceId, quality, captureWidth, captureHeight, multiMonitor)),
    sendOCR: (dataUrl) => ipcRenderer.send('ocr-process', dataUrl),
    sendCopyImage: (dataUrl) => ipcRenderer.send('snip-copy-v2', dataUrl), // RENAMED due to channel blocking
    sendCopyColor: (hex) => ipcRenderer.send('snip-copy-color', hex),
    sendSaveImage: (dataUrl) => ipcRenderer.send('snip-save-image', dataUrl),

    // Widget
    widgetAction: (action, data) => ipcRenderer.send('widget-action', action, data),
    onWidgetSide: (callback) => ipcRenderer.on('widget-side', (_, side) => callback(side)),
    onWidgetDirection: (callback) => ipcRenderer.on('widget-direction', (_, isUp) => callback(isUp)),
    onWidgetConfig: (callback) => ipcRenderer.on('widget-config', (_, config) => callback(config)),

    // Screenshot gallery
    getScreenshots: () => ipcRenderer.invoke('get-screenshots'),
    copyScreenshot: (id) => ipcRenderer.send('copy-screenshot', id),
    deleteScreenshot: (id) => ipcRenderer.send('delete-screenshot', id),
    showScreenshotFile: (id) => ipcRenderer.send('show-screenshot-file', id),
    openScreenshotFolder: () => ipcRenderer.send('open-screenshot-folder'),
    showScreenshotMenu: (id) => ipcRenderer.send('screenshot-context-menu', id),
    onScreenshotsUpdated: (callback) => ipcRenderer.on('screenshots-updated', (_, list) => callback(list)),

    // Large screenshot viewer window
    openScreenshotViewer: (id) => ipcRenderer.send('open-screenshot-viewer', id),
    onViewerImage: (callback) => ipcRenderer.on('viewer-image', (_, data) => callback(data)),
    onViewerList: (callback) => ipcRenderer.on('viewer-list', (_, list) => callback(list)),
    viewerNav: (dir) => ipcRenderer.send('viewer-nav', dir),
    viewerSelect: (id) => ipcRenderer.send('viewer-select', id),
    viewerClose: () => ipcRenderer.send('viewer-close'),
    viewerCopyAnnotated: (dataUrl) => ipcRenderer.send('viewer-copy-annotated', dataUrl), // image + drawing, flattened

    // Quick-paste picker
    quickPastePick: (text) => ipcRenderer.send('quickpaste-pick', text),
    quickPasteDismiss: () => ipcRenderer.send('quickpaste-dismiss'),
    onQuickPasteShow: (callback) => ipcRenderer.on('quickpaste-show', (_, data) => callback(data)),

    recordStart: () => ipcRenderer.send('record-start'),
    recordChunk: (buffer) => ipcRenderer.send('record-chunk', buffer),
    recordStop: () => ipcRenderer.send('record-stop'),
    closeSnipper: () => ipcRenderer.send('snip-close'),
    notifyReady: () => ipcRenderer.send('snip-ready'),
    retryCapture: () => ipcRenderer.send('capture-retry'), // unusable screenshot → ask main to re-capture
    claimCaptureMonitor: () => ipcRenderer.send('capture-claim-monitor'),
    onCaptureReset: (callback) => ipcRenderer.on('capture-reset', () => callback()),
    onShowToast: (callback) => ipcRenderer.on('display-toast', (_, message, type) => callback(message, type)),
    onResetView: (callback) => ipcRenderer.on('reset-view', callback),
    sendDebugLog: (msg) => ipcRenderer.send('debug-log', msg), // NEW DEBUG CHANNEL

    // Auto-Update
    checkForUpdates: () => ipcRenderer.send('check-for-updates'),
    downloadUpdate: () => ipcRenderer.send('download-update'),
    installUpdate: () => ipcRenderer.send('install-update'),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_, info) => callback(info)),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (_, info) => callback(info)),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_, progress) => callback(progress)),
    onUpdateInfo: (callback) => ipcRenderer.on('update-info', (_, info) => callback(info)),
    onUpdateError: (callback) => ipcRenderer.on('update-error', (_, err) => callback(err))
});
