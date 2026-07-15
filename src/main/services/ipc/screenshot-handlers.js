const { ipcMain, clipboard, nativeImage, shell, Menu, BrowserWindow } = require('electron');
const fs = require('fs');
const { showToast } = require('../window-manager');
const { publicList, getScreenshotById, deleteScreenshot, pruneMissing } = require('../screenshot-library');

// Screenshot gallery IPC (main window).

// Return the shot only if its file still exists; if it was deleted/moved outside the
// app, drop the stale index entry (which refreshes the grid) and tell the user.
function shotOrPrune(id) {
    const shot = getScreenshotById(id);
    if (!shot) return null;
    if (!fs.existsSync(shot.file)) {
        deleteScreenshot(id);
        showToast('Dosya bulunamadı, galeriden kaldırıldı.', 'info');
        return null;
    }
    return shot;
}

function copyShot(id) {
    const shot = shotOrPrune(id);
    if (!shot) return;
    try {
        const img = nativeImage.createFromPath(shot.file);
        if (img.isEmpty()) throw new Error('Görüntü okunamadı');
        clipboard.writeImage(img);
        showToast('Resim Kopyalandı.', 'success');
    } catch (err) {
        showToast('Kopyalama Hatası: ' + err.message, 'error');
    }
}

function revealShot(id) {
    const shot = shotOrPrune(id);
    if (shot) shell.showItemInFolder(shot.file);
}

function removeShot(id) {
    if (!getScreenshotById(id)) return;
    deleteScreenshot(id);
    showToast('Ekran görüntüsü silindi.', 'info');
}

function registerScreenshotHandlers() {
    // Prune stale entries whenever the grid is (re)loaded.
    ipcMain.handle('get-screenshots', () => { pruneMissing(); return publicList(); });

    // Full-size image for the preview pane, as a data URL (the sandboxed renderer can't
    // read arbitrary file paths, and the CSP only allows 'self' + data: images).
    ipcMain.handle('get-screenshot-full', (e, id) => {
        const shot = shotOrPrune(id);
        if (!shot) return null;
        try {
            return 'data:image/png;base64,' + fs.readFileSync(shot.file).toString('base64');
        } catch (err) {
            deleteScreenshot(id); // vanished between the existence check and the read
            return null;
        }
    });

    ipcMain.on('copy-screenshot', (e, id) => copyShot(id));
    ipcMain.on('delete-screenshot', (e, id) => removeShot(id));
    ipcMain.on('show-screenshot-file', (e, id) => revealShot(id));

    // Right-click a thumbnail: native context menu with the same actions as the preview.
    ipcMain.on('screenshot-context-menu', (e, id) => {
        if (!getScreenshotById(id)) return;
        const win = BrowserWindow.fromWebContents(e.sender);
        const menu = Menu.buildFromTemplate([
            { label: 'Kopyala', click: () => copyShot(id) },
            { label: 'Klasörde Göster', click: () => revealShot(id) },
            { type: 'separator' },
            { label: 'Sil', click: () => removeShot(id) }
        ]);
        menu.popup(win ? { window: win } : {});
    });
}

module.exports = { registerScreenshotHandlers };
