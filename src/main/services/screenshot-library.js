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
// The thumbnail is made in the shape the grid actually draws — cell-shaped, cropped, at
// twice the cell's CSS size — instead of being fitted inside a box.
//
// A cell is 159x108 CSS px (350px window, less the grid's 12px padding either side and its
// 8px gap, halved), so 318x216 DEVICE pixels on a 2x display, and the img is object-fit:
// cover. Fitting inside a box loses that argument badly for anything that is not roughly
// screen-shaped: a 766x8175 scroll capture contained in 360 is 34x360, and cover then has
// to blow those 34 pixels across the cell's 318 — nine times. At 220 a 785x16384 page came
// out ELEVEN pixels wide. Every scroll capture in the gallery was a smear.
//
// So: scale to COVER the target, then crop to it. The crop is anchored at the top, because
// a page is recognised by its header rather than by whatever lands in its middle. Nothing
// is ever upscaled — a source smaller than the target simply stays small.
const THUMB_W = 360;
const THUMB_H = 245; // ~the cell's 159:108, so the grid's cover crop has nothing left to do

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

// One-time repair for entries whose thumbnail predates the rule above. Without it the
// change would only reach screenshots taken from now on, and a gallery of scroll captures
// — the ones the old rule hurt most — would stay smeared until they aged out.
//
// One entry per turn of the event loop, and only after the window is up: some of these
// PNGs are 16000px tall, and decoding thirty of them in a row would hold the main process
// for seconds at exactly the moment the app is trying to appear.
function upgradeThumbnails() {
    const pending = listScreenshots()
        .filter(s => s.file && fs.existsSync(s.file))
        .filter(s => {
            const img = nativeImage.createFromDataURL(s.thumb || '');
            if (img.isEmpty()) return true;
            const have = img.getSize();
            // Compared against what THIS source can actually give, so an entry whose
            // original is small is left alone instead of being redone on every launch.
            const want = thumbSizeFor(s.w, s.h);
            return have.width < want.w || have.height < want.h;
        })
        .map(s => s.id);

    if (!pending.length) return;
    let repaired = 0;

    const step = () => {
        const id = pending.shift();
        if (id === undefined) {
            if (repaired) broadcastScreenshots();
            return;
        }
        try {
            const items = listScreenshots();
            const item = items.find(s => s.id === id);
            if (item && fs.existsSync(item.file)) {
                item.thumb = 'data:image/jpeg;base64,'
                    + makeThumb(fs.readFileSync(item.file)).toJPEG(80).toString('base64');
                store.set('screenshots', items);
                repaired++;
            }
        } catch (err) {
            // A missing or unreadable file is not worth failing over — it keeps its old
            // thumbnail and pruneMissing() will deal with it.
            console.error('Thumbnail upgrade failed:', err.message);
        }
        setTimeout(step, 0);
    };
    setTimeout(step, 1500);
}

// Geometry only: what a source of this size turns into. Shared with the upgrade pass, so
// it can tell whether an entry is already as good as it can get without decoding the PNG.
function thumbSizeFor(w, h) {
    if (!w || !h) return { w: 0, h: 0, scale: 1 };
    // Cover, never upscale: whichever axis is short decides the scale.
    const scale = Math.min(1, Math.max(THUMB_W / w, THUMB_H / h));
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    return { w: Math.min(sw, THUMB_W), h: Math.min(sh, THUMB_H), scale, sw, sh };
}

// Cover the target box, then take the top of it. Returns a NativeImage.
function makeThumb(pngBuffer) {
    const img = nativeImage.createFromBuffer(pngBuffer);
    const size = img.getSize();
    if (!size.width || !size.height) return img;

    const want = thumbSizeFor(size.width, size.height);
    // 'best' costs a few ms once per capture and is the difference between a clean
    // downscale of text and a soft one.
    const scaled = img.resize({ width: want.sw, height: want.sh, quality: 'best' });
    if (want.w === want.sw && want.h === want.sh) return scaled;
    // Horizontally centred, vertically from the top — the header is what identifies a page.
    return scaled.crop({ x: Math.round((want.sw - want.w) / 2), y: 0, width: want.w, height: want.h });
}

// Returns the gallery id the buffer ended up under — callers may want to jump to it.

function addScreenshot(pngBuffer) {
    const items = listScreenshots();

    // Copy-then-save of the same image fires two adds back to back — index it once.
    const hash = crypto.createHash('sha1').update(pngBuffer).digest('hex');
    if (items[0] && items[0].hash === hash) return items[0].id;

    const dir = screenshotsDir();
    fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomUUID();
    const file = path.join(dir, `snip_${Date.now()}_${id.slice(0, 8)}.png`);
    fs.writeFileSync(file, pngBuffer);

    const size = nativeImage.createFromBuffer(pngBuffer).getSize();
    const thumb = 'data:image/jpeg;base64,' + makeThumb(pngBuffer).toJPEG(80).toString('base64');

    items.unshift({ id, file, hash, timestamp: new Date().toISOString(), w: size.width, h: size.height, thumb });
    while (items.length > MAX_SCREENSHOTS) {
        const dropped = items.pop();
        try { fs.unlinkSync(dropped.file); } catch (e) { /* already gone — index is the source of truth */ }
    }
    store.set('screenshots', items);
    broadcastScreenshots();
    return id;
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

module.exports = { addScreenshot, publicList, getScreenshotById, deleteScreenshot, pruneMissing, screenshotsDir, upgradeThumbnails };
