const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { state, store } = require('./state');

// Screenshot gallery: screenshots the user finishes in the snipper (copied to the
// clipboard or saved to disk) are ALSO persisted here, so earlier captures can be
// browsed again from the main window. Full PNGs live under userData/screenshots;
// a small index — with an embedded thumbnail data URL for instant grid rendering —
// lives in the electron-store under 'screenshots'.

const MAX_SCREENSHOTS = 30;
const THUMB_WIDTH = 220;

function screenshotsDir() {
    return path.join(app.getPath('userData'), 'screenshots');
}

function listScreenshots() {
    return store.get('screenshots', []);
}

// Index entries without the file path / hash — what the renderer gets.
function publicList() {
    return listScreenshots().map(({ id, timestamp, w, h, thumb }) => ({ id, timestamp, w, h, thumb }));
}

function broadcastScreenshots() {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('screenshots-updated', publicList());
    }
}

function addScreenshot(pngBuffer) {
    const items = listScreenshots();

    // Copy-then-save of the same image fires two adds back to back — index it once.
    const hash = crypto.createHash('sha1').update(pngBuffer).digest('hex');
    if (items[0] && items[0].hash === hash) return;

    const dir = screenshotsDir();
    fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomUUID();
    const file = path.join(dir, `snip_${Date.now()}_${id.slice(0, 8)}.png`);
    fs.writeFileSync(file, pngBuffer);

    const img = nativeImage.createFromBuffer(pngBuffer);
    const size = img.getSize();
    const thumb = 'data:image/jpeg;base64,' + img.resize({ width: THUMB_WIDTH }).toJPEG(80).toString('base64');

    items.unshift({ id, file, hash, timestamp: new Date().toISOString(), w: size.width, h: size.height, thumb });
    while (items.length > MAX_SCREENSHOTS) {
        const dropped = items.pop();
        try { fs.unlinkSync(dropped.file); } catch (e) { /* already gone — index is the source of truth */ }
    }
    store.set('screenshots', items);
    broadcastScreenshots();
}

function getScreenshotById(id) {
    return listScreenshots().find(s => s.id === id) || null;
}

function deleteScreenshot(id) {
    const items = listScreenshots();
    const index = items.findIndex(s => s.id === id);
    if (index === -1) return;
    try { fs.unlinkSync(items[index].file); } catch (e) { }
    items.splice(index, 1);
    store.set('screenshots', items);
    broadcastScreenshots();
}

// Drop index entries whose PNG file was deleted/moved outside the app, so their dead
// thumbnails don't linger in the grid. Returns true if anything was pruned.
function pruneMissing() {
    const items = listScreenshots();
    const kept = items.filter(s => { try { return fs.existsSync(s.file); } catch (e) { return false; } });
    if (kept.length !== items.length) {
        store.set('screenshots', kept);
        broadcastScreenshots();
        return true;
    }
    return false;
}

module.exports = { addScreenshot, publicList, getScreenshotById, deleteScreenshot, pruneMissing, screenshotsDir };
