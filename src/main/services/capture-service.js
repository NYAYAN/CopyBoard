const { desktopCapturer, screen, systemPreferences, dialog, shell } = require('electron');
const { state } = require('./state');
const { createCapture, showToast } = require('./window-manager');

async function startCapture(mode) {
    try {
        // macOS Permission Check
        if (process.platform === 'darwin') {
            try {
                const status = systemPreferences.getMediaAccessStatus('screen');
                if (status !== 'granted') {
                    const { response } = await dialog.showMessageBox({
                        type: 'warning',
                        buttons: ['Ayarları Aç', 'İptal'],
                        defaultId: 0,
                        message: 'Ekran Kaydı İzni Gerekli',
                        detail: 'CopyBoard ekran görüntüsü alabilmek için "Ekran Kaydı" iznine ihtiyaç duyar.\n\nSistem Ayarları > Gizlilik ve Güvenlik > Ekran Kaydı bölümünden uygulamaya izin verin.'
                    });

                    if (response === 0) {
                        try {
                            await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
                        } catch (err) { console.error('Failed to open system prefs', err); }
                    }
                    return;
                }
            } catch (permErr) {
                console.error('Permission check failed:', permErr);
            }
        }

        if (state.isCapturing) {
            if (typeof showToast === 'function') showToast('İşlem devam ediyor...', 'warning');
            return;
        }
        state.isCapturing = true;

        const cursorPoint = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursorPoint);
        const { width, height } = display.bounds;
        const scaleFactor = display.scaleFactor || 1;

        // Physical pixel dimensions — this is what Snipping Tool uses
        const captureWidth = Math.round(width * scaleFactor);
        const captureHeight = Math.round(height * scaleFactor);

        let sources;
        try {
            // Capture at PHYSICAL pixel resolution — this gives us native quality like Snipping Tool
            sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: captureWidth, height: captureHeight },
                fetchWindowIcons: false
            });
        } catch (sourceErr) {
            throw new Error(`Ekran kaynakları alınamadı: ${sourceErr.message || sourceErr}`);
        }

        const source = sources.find(s => s.display_id == display.id) || sources[0];

        if (source) {
            // Get the pixel-perfect screenshot as PNG data URL
            const thumbnail = source.thumbnail;
            const dataUrl = thumbnail.toDataURL();

            const sourceId = source.id;

            state.lastMode = mode;
            const win = createCapture(mode, display);
            win.webContents.on('did-finish-load', () => {
                if (!win.isDestroyed()) {
                    // Send the high-res screenshot data URL + sourceId (for video mode getUserMedia)
                    win.webContents.send('capture-screen', dataUrl, mode, sourceId, state.videoQuality, captureWidth, captureHeight);
                }
            });
        } else {
            state.isCapturing = false;
        }

    } catch (e) {
        // Global Error Handler for Capture Service
        state.isCapturing = false;
        console.error('Capture Service Critical Error:', e);

        try {
            if (typeof showToast === 'function') {
                showToast('Hata: ' + (e.message || 'Bilinmeyen Hata'), 'error');
            }
        } catch (toastErr) {
            console.error('Failed to show toast:', toastErr);
        }
    }
}

module.exports = { startCapture };
