const { ipcMain, shell } = require('electron');
const { state } = require('../state');
const { checkForUpdates, downloadUpdate, installUpdate } = require('../update-manager');

// Auto-update controls + the "open this URL externally" bridge used by the update dialog.
function registerUpdateHandlers() {
    ipcMain.on('check-for-updates', checkForUpdates);
    ipcMain.on('download-update', downloadUpdate);
    ipcMain.on('install-update', installUpdate);
    ipcMain.on('open-url', (e, url) => {
        if (!url || typeof url !== 'string') return;

        // Protocol validation for security (Only allow web URLs)
        const allowedProtocols = ['http:', 'https:'];
        try {
            const parsedUrl = new URL(url);
            if (!allowedProtocols.includes(parsedUrl.protocol)) {
                console.warn(`[Security]: Blocked attempt to open non-web URL: ${url}`);
                return;
            }
            shell.openExternal(url);
        } catch (err) {
            console.error('[Security]: Invalid URL provided to open-url:', url);
            return;
        }

        // Close update window if it exists
        if (state.updateWindow && !state.updateWindow.isDestroyed()) {
            state.updateWindow.close();
        }
    });
}

module.exports = { registerUpdateHandlers };
