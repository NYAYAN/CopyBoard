const { ipcMain, clipboard, nativeImage, shell } = require('electron');
const fs = require('fs');
const { showToast } = require('../window-manager');
const { publicList, getScreenshotById, deleteScreenshot } = require('../screenshot-library');

// Screenshot gallery IPC (main window).
function registerScreenshotHandlers() {
    ipcMain.handle('get-screenshots', () => publicList());

    // Full-size image for the preview pane, as a data URL (the sandboxed renderer can't
    // read arbitrary file paths, and the CSP only allows 'self' + data: images).
    ipcMain.handle('get-screenshot-full', (e, id) => {
        const shot = getScreenshotById(id);
        if (!shot) return null;
        try {
            return 'data:image/png;base64,' + fs.readFileSync(shot.file).toString('base64');
        } catch (err) {
            console.error('Screenshot read failed:', err);
            return null;
        }
    });

    ipcMain.on('copy-screenshot', (e, id) => {
        const shot = getScreenshotById(id);
        if (!shot) return;
        try {
            const img = nativeImage.createFromPath(shot.file);
            if (img.isEmpty()) throw new Error('Görüntü okunamadı');
            clipboard.writeImage(img);
            showToast('Resim Kopyalandı.', 'success');
        } catch (err) {
            showToast('Kopyalama Hatası: ' + err.message, 'error');
        }
    });

    ipcMain.on('delete-screenshot', (e, id) => {
        deleteScreenshot(id);
        showToast('Ekran görüntüsü silindi.', 'info');
    });

    ipcMain.on('show-screenshot-file', (e, id) => {
        const shot = getScreenshotById(id);
        if (shot) shell.showItemInFolder(shot.file);
    });
}

module.exports = { registerScreenshotHandlers };
