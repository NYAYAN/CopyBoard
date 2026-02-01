const { autoUpdater } = require('electron-updater');
const { state } = require('./state');
const { showToast } = require('./window-manager');
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

// Configuration
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let updateWindow = null;

function createUpdateWindow(updateInfo) {
    if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.focus();
        return;
    }

    const display = screen.getPrimaryDisplay();
    const { width, height } = display.workAreaSize;

    updateWindow = new BrowserWindow({
        width: 380,
        height: 500,
        x: Math.floor(display.workArea.x + (width - 350) / 2),
        y: Math.floor(display.workArea.y + (height - 500) / 2),
        frame: false,
        transparent: true,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: false,
        icon: path.join(__dirname, '../../../icon.png'),
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    updateWindow.loadFile(path.join(__dirname, '../../renderer/update/update-dialog.html'));

    updateWindow.once('ready-to-show', () => {
        if (updateWindow && !updateWindow.isDestroyed()) {
            updateWindow.show();
            updateWindow.webContents.send('update-info', {
                version: updateInfo.version,
                currentVersion: app.getVersion(),
                releaseNotes: updateInfo.releaseNotes,
                releaseName: updateInfo.releaseName,
                isMac: process.platform === 'darwin'
            });
        }
    });

    updateWindow.on('closed', () => {
        updateWindow = null;
    });
}

function initAutoUpdater() {
    autoUpdater.on('checking-for-update', () => console.log('Checking for updates...'));

    autoUpdater.on('update-available', (info) => {
        console.log('Update available:', info.version);
        createUpdateWindow(info);
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('No updates available');
        if (state.manualUpdateCheck) {
            showToast('Zaten en güncel sürümü kullanıyorsunuz.', 'info');
            state.manualUpdateCheck = false;
        }
    });

    autoUpdater.on('error', (err) => {
        console.error('Update error:', err);
        // Do not close window on error, let user see the message
        // if (updateWindow && !updateWindow.isDestroyed()) {
        //     updateWindow.close();
        // }

        if (state.manualUpdateCheck) {
            showToast('Güncelleme kontrolü başarısız oldu', 'error');
            state.manualUpdateCheck = false;
        }
        // Notify window if open
        if (updateWindow && !updateWindow.isDestroyed()) {
            updateWindow.webContents.send('update-error', err.message || 'Güncelleme hatası');
        }
    });

    autoUpdater.on('download-progress', (progressObj) => {
        console.log(`Download progress: ${Math.round(progressObj.percent)}%`);
        if (updateWindow && !updateWindow.isDestroyed()) {
            updateWindow.webContents.send('download-progress', progressObj);
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('Update downloaded:', info.version);
        if (updateWindow && !updateWindow.isDestroyed()) {
            updateWindow.webContents.send('update-downloaded');
        } else {
            showToast('Güncelleme indirildi! Uygulamayı yeniden başlatın.', 'success');
        }
    });
}

function checkForUpdates() {
    state.manualUpdateCheck = true;
    try {
        autoUpdater.checkForUpdates().catch(err => {
            console.error('Check for updates failed:', err);
            showToast('Güncelleme kontrolü başarısız oldu', 'error');
        });
    } catch (err) {
        console.error('Check for updates error:', err);
    }
}

function downloadUpdate() {
    try {
        const downloadPromise = autoUpdater.downloadUpdate();
        if (downloadPromise && typeof downloadPromise.catch === 'function') {
            downloadPromise.catch(err => {
                console.error('Download update failed:', err);
                if (updateWindow && !updateWindow.isDestroyed()) {
                    updateWindow.webContents.send('update-error', err.message || 'İndirme başlatılamadı');
                }
            });
        }
    } catch (err) {
        console.error('Download update synchronous error:', err);
        if (updateWindow && !updateWindow.isDestroyed()) {
            updateWindow.webContents.send('update-error', err.message || 'Beklenmeyen hata');
        }
    }
}

function installUpdate() {
    try {
        autoUpdater.quitAndInstall(false, true);
    } catch (err) {
        console.error('Install update error:', err);
    }
}

module.exports = {
    initAutoUpdater,
    checkForUpdates,
    downloadUpdate,
    installUpdate
};
