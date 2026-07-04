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
        state.lastMode = mode;

        // Multi-monitor: dim EVERY display so the user can select on whichever monitor they
        // want (the selection stays within one monitor). One overlay window per display.
        const displays = screen.getAllDisplays();
        const multiMonitor = displays.length > 1;

        // Capture EACH display at ITS OWN native (physical-pixel) resolution. desktopCapturer
        // applies a single thumbnailSize to the whole getSources() call, so a shared "largest
        // monitor" size upscales-then-downscales lower-res screens — e.g. a 1080p laptop next to
        // a 4K monitor came out blurry. Calling getSources() once per display, sized to that
        // display, keeps every monitor pixel-sharp (native quality like Snipping Tool).
        let createdAny = false;
        for (let i = 0; i < displays.length; i++) {
            const display = displays[i];
            const scaleFactor = display.scaleFactor || 1;
            const captureWidth = Math.round(display.bounds.width * scaleFactor);
            const captureHeight = Math.round(display.bounds.height * scaleFactor);

            let sources;
            try {
                sources = await desktopCapturer.getSources({
                    types: ['screen'],
                    thumbnailSize: { width: captureWidth, height: captureHeight },
                    fetchWindowIcons: false
                });
            } catch (sourceErr) {
                console.error(`Ekran kaynağı alınamadı (display ${display.id}):`, sourceErr);
                continue;
            }

            // Match this display to its screen source; if display_id is unavailable (empty on
            // some GPU/RDP configs) fall back to index order, then to the first source.
            let source = sources.find(s => String(s.display_id) === String(display.id));
            if (!source) source = sources[i] || sources[0];
            if (!source) continue;

            // toPNG() for lossless quality — toDataURL() may lose color fidelity.
            const dataUrl = 'data:image/png;base64,' + source.thumbnail.toPNG().toString('base64');
            const sourceId = source.id;

            const win = createCapture(mode, display);
            win.webContents.on('did-finish-load', () => {
                if (!win.isDestroyed()) {
                    // Screenshot data URL + THIS monitor's sourceId (video getUserMedia records
                    // this monitor). Crop is emitted at native pixels and written via nativeImage
                    // scaleFactor 1.0, so paste size stays monitor-independent.
                    win.webContents.send('capture-screen', dataUrl, mode, sourceId, state.videoQuality, captureWidth, captureHeight, multiMonitor);
                }
            });
            createdAny = true;
        }

        if (!createdAny) {
            throw new Error('Ekran kaynakları alınamadı');
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
