const { ipcMain, clipboard, nativeImage, shell, Menu, BrowserWindow, screen } = require('electron');
const { t } = require('../i18n');
const fs = require('fs');
const path = require('path');
const { showToast } = require('../window-manager');
const { addScreenshot, publicList, getScreenshotById, deleteScreenshot, pruneMissing, screenshotsDir } = require('../screenshot-library');

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

// Full-size PNG as a data URL (the sandboxed renderers can't read arbitrary file
// paths, and their CSP only allows 'self' + data: images). The byte count rides along
// for the viewer's title — the file is already in hand, so it costs nothing.
function shotDataUrl(id) {
    const shot = shotOrPrune(id);
    if (!shot) return null;
    try {
        const buffer = fs.readFileSync(shot.file);
        return { shot, dataUrl: 'data:image/png;base64,' + buffer.toString('base64'), size: buffer.length };
    } catch (err) {
        deleteScreenshot(id); // vanished between the existence check and the read
        return null;
    }
}

// ── Large viewer ──────────────────────────────────────────────────────────────
// A dedicated resizable window sized to the screenshot (capped to the display's
// work area). The in-panel preview is confined to the 350px main window, which is
// no way to actually inspect a full-resolution capture.
let viewerWindow = null;
let viewerPayload = null; // latest requested image — sent on did-finish-load

// Payload for one shot, with its position in the gallery ("3 / 26") so the viewer
// can show where the ←/→ navigation currently is.
function viewerPayloadFor(id) {
    const r = shotDataUrl(id);
    if (!r) return null;
    const list = publicList();
    const idx = list.findIndex(s => s.id === r.shot.id);
    return {
        id: r.shot.id, dataUrl: r.dataUrl, size: r.size,
        w: r.shot.w, h: r.shot.h, timestamp: r.shot.timestamp,
        pos: idx + 1, total: list.length
    };
}

// Thumbnails for the viewer's bottom filmstrip (click to switch image).
const stripList = () => publicList().map(s => ({ id: s.id, thumb: s.thumb }));

// Push the current strip + image to the viewer. Callers guard against the first
// load still being in flight (did-finish-load delivers the state then) — the check
// can NOT live here: isLoading() may still report true inside did-finish-load
// itself, which would drop the initial image.
function sendViewerState() {
    if (!viewerWindow || viewerWindow.isDestroyed()) return;
    viewerWindow.webContents.send('viewer-list', stripList());
    if (viewerPayload) viewerWindow.webContents.send('viewer-image', viewerPayload);
}

function openViewer(id) {
    const payload = viewerPayloadFor(id);
    if (!payload) return;

    const CHROME_H = 44 + 64; // toolbar row + bottom thumbnail strip
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    // Fit the image (never upscale), keep room for the chrome, center on screen.
    const scale = Math.min(1, (wa.width * 0.85) / payload.w, (wa.height * 0.85 - CHROME_H) / payload.h);
    const width = Math.max(480, Math.round(payload.w * scale));
    const height = Math.max(320, Math.round(payload.h * scale) + CHROME_H);
    const bounds = {
        x: Math.round(wa.x + (wa.width - width) / 2),
        y: Math.round(wa.y + (wa.height - height) / 2),
        width, height
    };

    viewerPayload = payload;

    if (viewerWindow && !viewerWindow.isDestroyed()) {
        viewerWindow.setBounds(bounds);
        // While the first load is in flight, skip — did-finish-load sends the
        // latest viewerPayload anyway.
        if (!viewerWindow.webContents.isLoading()) sendViewerState();
        viewerWindow.show();
        viewerWindow.focus();
        return;
    }

    viewerWindow = new BrowserWindow({
        ...bounds,
        minWidth: 480,
        minHeight: 320,
        frame: false,
        backgroundColor: '#1c1c1e',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../../../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    viewerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    viewerWindow.loadFile(path.join(__dirname, '../../../renderer/viewer/viewer.html'));
    viewerWindow.webContents.on('did-finish-load', () => {
        if (viewerWindow && !viewerWindow.isDestroyed() && viewerPayload) {
            sendViewerState();
            viewerWindow.show();
        }
    });
    viewerWindow.on('closed', () => { viewerWindow = null; viewerPayload = null; });
}

// Swap the displayed shot WITHOUT touching the window bounds — used by the ←/→
// keys and filmstrip clicks, so the window stays where the user put it.
function viewerShow(id) {
    if (!viewerWindow || viewerWindow.isDestroyed()) return;
    const payload = viewerPayloadFor(id);
    if (!payload) return;
    viewerPayload = payload;
    if (!viewerWindow.webContents.isLoading()) sendViewerState();
}

function copyShot(id) {
    const shot = shotOrPrune(id);
    if (!shot) return;
    try {
        const img = nativeImage.createFromPath(shot.file);
        if (img.isEmpty()) throw new Error(t('Görüntü okunamadı'));
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

// Every delete entry point (gallery grid, context menu, the viewer's own Sil button) lands
// here, so this is where an open viewer gets straightened out: step to the neighbour when
// the shot on screen is the one going away, close when it was the last one, and otherwise
// just refresh the strip and the "3 / 26" counter.
function removeShot(id) {
    if (!getScreenshotById(id)) return;
    const list = publicList(); // neighbours have to be read BEFORE the entry disappears
    const idx = list.findIndex(s => s.id === id);
    const neighbour = list[idx + 1] || list[idx - 1] || null;

    deleteScreenshot(id);
    showToast('Ekran görüntüsü silindi.', 'info');

    if (!viewerWindow || viewerWindow.isDestroyed() || !viewerPayload) return;
    if (viewerPayload.id === id) {
        if (neighbour) viewerShow(neighbour.id);
        else viewerWindow.close();
    } else {
        // Some other shot went away: re-send the current one so the strip and the counter
        // both settle on the new list (same id, so nothing on screen is disturbed).
        viewerShow(viewerPayload.id);
    }
}

function registerScreenshotHandlers() {
    // Prune stale entries whenever the grid is (re)loaded.
    ipcMain.handle('get-screenshots', () => { pruneMissing(); return publicList(); });

    ipcMain.on('copy-screenshot', (e, id) => copyShot(id));
    ipcMain.on('delete-screenshot', (e, id) => removeShot(id));
    ipcMain.on('show-screenshot-file', (e, id) => revealShot(id));

    // Toolbar action: reveal the gallery FOLDER (not one file). The directory is created
    // lazily on the first saved screenshot, so it may legitimately not exist yet.
    ipcMain.on('open-screenshot-folder', async () => {
        const dir = screenshotsDir();
        if (!fs.existsSync(dir)) {
            showToast('Henüz ekran görüntüsü yok.', 'info');
            return;
        }
        const err = await shell.openPath(dir);
        if (err) showToast('Klasör açılamadı: ' + err, 'error');
    });

    // Large viewer window (opened from the gallery preview or the context menu).
    ipcMain.on('open-screenshot-viewer', (e, id) => openViewer(id));
    ipcMain.on('viewer-close', () => {
        if (viewerWindow && !viewerWindow.isDestroyed()) viewerWindow.close();
    });

    // ←/→ inside the viewer: step through the gallery (newest-first order, no wrap).
    ipcMain.on('viewer-nav', (e, dir) => {
        if (!viewerPayload) return;
        const list = publicList();
        const idx = list.findIndex(s => s.id === viewerPayload.id);
        if (idx === -1) return;
        const target = list[idx + (dir === 'next' ? 1 : -1)];
        if (target) viewerShow(target.id);
    });

    // Filmstrip click: jump straight to a shot.
    ipcMain.on('viewer-select', (e, id) => viewerShow(id));

    // Edited copy: the viewer flattens its drawing onto the image (cropped to the selected
    // region, if there is one) and sends a PNG data URL. It goes into the gallery as its own
    // entry too — same deal as a fresh snip, so the edited version outlives the next
    // clipboard write instead of being one-shot.
    ipcMain.on('viewer-copy-annotated', (e, dataUrl) => {
        try {
            const buffer = Buffer.from(String(dataUrl).split(',')[1], 'base64');
            // Already at the image's native resolution — no display-scale compensation.
            const img = nativeImage.createFromBuffer(buffer, { scaleFactor: 1.0 });
            if (img.isEmpty()) throw new Error(t('Görüntü oluşturulamadı'));
            clipboard.writeImage(img);
            let newId = null;
            try { newId = addScreenshot(buffer); } catch (galleryErr) { console.error('Gallery save failed:', galleryErr); }
            showToast('Düzenlenen resim kopyalandı.', 'success');
            // Switch the viewer to the copy that was just filed: the user sees exactly what
            // landed on the clipboard, and further edits build on it. Bounds are left alone
            // (the window stays where it was put). If the gallery write failed, fall back to
            // re-sending the current shot so at least the strip and "3 / 26" stay honest.
            if (newId) viewerShow(newId);
            else if (viewerPayload) viewerShow(viewerPayload.id);
        } catch (err) {
            showToast('Kopyalama Hatası: ' + err.message, 'error');
        }
    });

    // Right-click a thumbnail: native context menu with the same actions as the preview.
    ipcMain.on('screenshot-context-menu', (e, id) => {
        if (!getScreenshotById(id)) return;
        const win = BrowserWindow.fromWebContents(e.sender);
        const menu = Menu.buildFromTemplate([
            { label: t('Büyük Görüntüle'), click: () => openViewer(id) },
            { label: t('Kopyala'), click: () => copyShot(id) },
            { label: t('Klasörde Göster'), click: () => revealShot(id) },
            { type: 'separator' },
            { label: t('Sil'), click: () => removeShot(id) }
        ]);
        menu.popup(win ? { window: win } : {});
    });
}

module.exports = { registerScreenshotHandlers };
