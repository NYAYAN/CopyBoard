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

        // Ensure integer dimensions and account for scale factor for high DPI
        // Use ceil to avoid rounding down errors that might cause scaling blur
        const thumbWidth = Math.ceil(width * scaleFactor);
        const thumbHeight = Math.ceil(height * scaleFactor);

        let sources;
        try {
            sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: thumbWidth, height: thumbHeight }
            });
        } catch (sourceErr) {
            throw new Error(`Ekran kaynakları alınamadı: ${sourceErr.message || sourceErr}`);
        }

        const source = sources.find(s => s.display_id == display.id) || sources[0];

        if (source) {
            // Use PNG for maximum quality transfer if possible, or skip toDataURL and handle differently?
            // For now, increasing the source thumbnail resolution is the biggest win.
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
