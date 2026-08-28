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
    const STAGE_PAD = 10;     // .stage padding in viewer.css — the minimum gutter
    const PAD_H = STAGE_PAD * 2;
    const FILL = 0.8;         // the share of the stage the image should take when there's room
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    // The most stage this display can carry, once the chrome and the padding are paid for.
    const roomW = wa.width * 0.85 - PAD_H;
    const roomH = wa.height * 0.85 - CHROME_H - PAD_H;
    // 1:1 comes first — a screenshot drawn at 94% is a blurry screenshot — so the image
    // scale is only ever "as large as fits, never upscaled".
    const scale = Math.min(1, roomW / payload.w, roomH / payload.h);
    // Then the stage is opened LARGER than the picture, so the picture sits in some space
    // instead of against the frame: enough that it takes FILL of the stage, or whatever
    // the display leaves over, whichever is smaller. A shot too big for the screen can't
    // have that space and keeps the 10px padding as its gutter.
    const stageW = Math.min(Math.round(payload.w * scale / FILL), Math.floor(roomW));
    const stageH = Math.min(Math.round(payload.h * scale / FILL), Math.floor(roomH));
    const width = Math.max(480, stageW + PAD_H);
    const height = Math.max(320, stageH + CHROME_H + PAD_H);
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
        // Every other window of the app is skipTaskbar, so this is the only one whose
        // taskbar button is ever seen — name its icon rather than leaving Windows to dig
        // one out of the executable.
        icon: path.join(__dirname, '../../../../icon.png'),
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

    // Maximizing hands a FRAMELESS window its resize border as overhang: on Windows the
    // window rect lands past the work area on every side (measured: -8,-8 +16x16 at 100%
    // scale), so the toolbar's top row, the close button's right edge and the filmstrip's
    // bottom row are all drawn off screen — the bottom one behind the taskbar. The rect is
    // not ours to correct: Chromium keeps that window style for the drop shadow and the
    // snap gestures, and setBounds() is ignored while the window is maximized (measured).
    // The CONTENT is inset by whatever the overhang actually is instead — never a
    // hardcoded 8, which moves with the DPI — and back to zero on unmaximize.
    //
    // The same message carries the maximized flag, because the toolbar's own maximize
    // button has to show the restore glyph whenever the window IS maximized — including
    // when that came from a double click on the drag region or a snap gesture, which the
    // button never hears about.
    const sendWindowState = () => {
        if (!viewerWindow || viewerWindow.isDestroyed()) return;
        const b = viewerWindow.getBounds();
        const wa = screen.getDisplayMatching(b).workArea;
        const maximized = viewerWindow.isMaximized();
        viewerWindow.webContents.send('viewer-window-state', {
            maximized,
            inset: maximized ? {
                top: Math.max(0, wa.y - b.y),
                right: Math.max(0, (b.x + b.width) - (wa.x + wa.width)),
                bottom: Math.max(0, (b.y + b.height) - (wa.y + wa.height)),
                left: Math.max(0, wa.x - b.x)
            } : { top: 0, right: 0, bottom: 0, left: 0 }
        });
    };
    viewerWindow.on('maximize', sendWindowState);
    viewerWindow.on('unmaximize', sendWindowState);

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

    // The window is frameless, so its own toolbar is the only place these can live. The
    // maximize toggle asks the window what it is rather than tracking it here: a double
    // click on the drag region and the snap gestures maximize it too.
    ipcMain.on('viewer-minimize', () => {
        if (viewerWindow && !viewerWindow.isDestroyed()) viewerWindow.minimize();
    });
    ipcMain.on('viewer-toggle-maximize', () => {
        if (!viewerWindow || viewerWindow.isDestroyed()) return;
        if (viewerWindow.isMaximized()) viewerWindow.unmaximize();
        else viewerWindow.maximize();
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

    // The compare grid needs the FULL images: the viewer holds exactly one of those (the
    // shot on screen) plus the strip's 360px thumbnails, and a comparison run at thumbnail
    // resolution is not a comparison. Ids that no longer resolve are dropped rather than
    // faked — shotDataUrl() prunes whatever vanished off disk on the way past, so the grid
    // and the gallery cannot end up disagreeing about what exists.
    ipcMain.handle('viewer-compare-images', (e, ids) => {
        if (!Array.isArray(ids)) return [];
        return ids.map(id => {
            const r = shotDataUrl(id);
            return r && { id: r.shot.id, dataUrl: r.dataUrl, size: r.size, w: r.shot.w, h: r.shot.h, timestamp: r.shot.timestamp };
        }).filter(Boolean);
    });

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
