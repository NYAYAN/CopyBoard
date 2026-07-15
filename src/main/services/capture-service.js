const { desktopCapturer, screen, systemPreferences, dialog, shell } = require('electron');
const { state } = require('./state');
const { createCapture, showToast, closeAllCaptureWindows } = require('./window-manager');

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
        // Open every display's overlay window IMMEDIATELY (hidden while its HTML loads) so
        // window creation + page load run in PARALLEL with the screen captures below — the
        // dim appears as soon as both are ready instead of after capture-then-load in series.
        // Overlays only become visible after they receive their screenshot ('snip-ready'),
        // and hidden windows are never included in desktopCapturer output, so they can't
        // contaminate the captured images.
        const wins = displays.map(display => createCapture(mode, display));
        const winReady = wins.map(win => new Promise(resolve => {
            win.webContents.once('did-finish-load', () => resolve(true));
            win.once('closed', () => resolve(false)); // e.g. ESC pressed while still loading
        }));

        // Capture displays with BOUNDED concurrency: parallel enough that the dim appears
        // fast, but capped so peak memory stays ~O(cap) native thumbnails instead of O(N^2)
        // when several high-DPI monitors are captured at once (each getSources returns one
        // thumbnail PER screen). The common 1-2 monitor case is still fully parallel. Each
        // display is captured at ITS OWN native size for pixel-sharpness.
        const CAPTURE_CONCURRENCY = 2;
        let createdAny = false;
        for (let start = 0; start < displays.length; start += CAPTURE_CONCURRENCY) {
            const batch = displays.slice(start, start + CAPTURE_CONCURRENCY);
            const batchResults = await Promise.all(batch.map(async (display, bi) => {
                const i = start + bi; // global display index (for the index fallback below)
                const scaleFactor = display.scaleFactor || 1;
                const captureWidth = Math.round(display.bounds.width * scaleFactor);
                const captureHeight = Math.round(display.bounds.height * scaleFactor);
                try {
                    const sources = await desktopCapturer.getSources({
                        types: ['screen'],
                        thumbnailSize: { width: captureWidth, height: captureHeight },
                        fetchWindowIcons: false
                    });
                    // Match this display to its screen source; if display_id is unavailable
                    // (empty on some GPU/RDP configs) fall back to index order, then first source.
                    let source = sources.find(s => String(s.display_id) === String(display.id));
                    if (!source) source = sources[i] || sources[0];
                    if (!source) return null;
                    return {
                        // toPNG() for lossless quality — toDataURL() may lose color fidelity.
                        dataUrl: 'data:image/png;base64,' + source.thumbnail.toPNG().toString('base64'),
                        sourceId: source.id,
                        captureWidth,
                        captureHeight
                    };
                } catch (sourceErr) {
                    console.error(`Ekran kaynağı alınamadı (display ${display.id}):`, sourceErr);
                    return null;
                }
            }));

            // Dispatch this batch: send each screenshot to its (possibly still-loading)
            // window as soon as BOTH are ready; close the windows of failed captures.
            batchResults.forEach((cap, bi) => {
                const win = wins[start + bi];
                if (!cap) {
                    if (win && !win.isDestroyed()) win.close();
                    return;
                }
                createdAny = true;
                winReady[start + bi].then((loaded) => {
                    if (loaded && !win.isDestroyed()) {
                        // Screenshot + THIS monitor's sourceId (video getUserMedia records
                        // this monitor). Crop is emitted at native pixels and written via
                        // nativeImage scaleFactor 1.0, so paste size stays monitor-independent.
                        win.webContents.send('capture-screen', cap.dataUrl, mode, cap.sourceId, state.videoQuality, cap.captureWidth, cap.captureHeight, multiMonitor);
                    }
                });
            });
        }

        if (!createdAny) {
            closeAllCaptureWindows();
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
