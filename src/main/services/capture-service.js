const { desktopCapturer, screen } = require('electron');
const { state } = require('./state');
const { createCapture, showToast } = require('./window-manager');

async function startCapture(mode) {
    if (state.isCapturing) {
        showToast('İşlem devam ediyor...', 'warning');
        return;
    }
    state.isCapturing = true;

    try {
        const cursorPoint = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursorPoint);
        const { width, height } = display.bounds;

        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
        const source = sources.find(s => s.display_id == display.id) || sources[0];

        if (source) {
            const data = source.thumbnail.toDataURL();
            const sourceId = source.id;
            state.lastMode = mode;
            const win = createCapture(mode, display);
            win.webContents.on('did-finish-load', () => {
                if (!win.isDestroyed()) win.webContents.send('capture-screen', data, mode, sourceId, state.videoQuality);
            });
        } else {
            state.isCapturing = false;
        }
    } catch (e) {
        state.isCapturing = false;
        showToast('Capture Hatası', 'error');
        console.error(e);
    }
}

module.exports = { startCapture };
