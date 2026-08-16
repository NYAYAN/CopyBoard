const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const selectionBox = document.getElementById('selection-box');
const overlay = document.getElementById('overlay');
const btnRecord = document.getElementById('btn-record');
const btnStop = document.getElementById('btn-stop');
const btnClose = document.getElementById('btn-close');
const btnFullscreen = document.getElementById('btn-fullscreen');
const toolbar = document.getElementById('recorder-toolbar');
const timerElement = document.getElementById('timer');
const instruction = document.querySelector('.instruction');
const qualitySelect = document.getElementById('quality-select');
const qualityLabel = document.getElementById('quality-label');
const btnMic = document.getElementById('btn-mic');
const btnSystemAudio = document.getElementById('btn-system-audio');

const state = {
    isSelecting: false, isMoving: false, isResizing: false,
    activeHandle: null, resizeStartRect: null, selectionRect: null,
    startX: 0, startY: 0, dragOffX: 0, dragOffY: 0,
    mediaRecorder: null, recordedChunks: [], startTime: 0, timerInterval: null,
    sourceId: null, isRecording: false, videoQuality: 'high', lastIgnoreState: null,
    audioMicOn: false, audioSystemOn: false,
    micStream: null, sysStream: null, audioContext: null,
    dpr: window.devicePixelRatio || 1,
    captureWidth: null,
    captureHeight: null,
    scaleX: null,
    scaleY: null
};

// Retained so the frozen backdrop can be repainted: assigning canvas.width/height WIPES the
// canvas, and behind this transparent window the live desktop looks identical to the frozen
// shot — a late resize used to silently swap one for the other.
let screenBitmap = null;

function paintScreen() {
    if (!screenBitmap) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(screenBitmap, 0, 0, canvas.width, canvas.height);
}

function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    state.dpr = dpr;

    if (screenBitmap) {
        // Backdrop loaded: keep its physical resolution, only restretch and rescale.
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        state.scaleX = canvas.width / w;
        state.scaleY = canvas.height / h;
        return;
    }

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// A capture targets one monitor: starting a region selection here clears the other monitors'
// selections; this one clears via onCaptureReset when another monitor starts. Newest wins.
function resetSelection() {
    if (state.isRecording) return;
    state.selectionRect = null;
    state.isSelecting = state.isMoving = state.isResizing = false;
    selectionBox.style.display = 'none';
    selectionBox.classList.add('hidden');
    overlay.style.display = 'block';
    if (instruction) instruction.style.display = '';
    document.body.classList.remove('selecting');
}
window.api.onCaptureReset(() => resetSelection());

window.api.onCaptureScreen((imageData, mode, sourceId, quality, captureWidth, captureHeight, multiMonitor) => {
    state.sourceId = sourceId;
    state.videoQuality = quality || 'high';
    if (qualitySelect) qualitySelect.value = state.videoQuality;

    const logicalW = window.innerWidth;
    const logicalH = window.innerHeight;
    const physW = captureWidth || logicalW;
    const physH = captureHeight || logicalH;

    state.captureWidth = physW;
    state.captureHeight = physH;
    state.scaleX = physW / logicalW;
    state.scaleY = physH / logicalH;

    screenBitmap = null;
    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = logicalW + 'px';
    canvas.style.height = logicalH + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Auto-place a default 500x500 box ONLY on a single monitor. With multiple monitors,
    // leave every overlay empty (dimmed + "select area") so the user draws the region on
    // the ONE monitor they want — a default box on every screen makes it unclear which
    // monitor records.
    const finish = () => {
        if (!multiMonitor) applyDefaultSize();
        window.api.notifyReady();
    };

    // Unusable screenshot → self-heal like the snipper: ask main to re-capture and re-send
    // (this handler re-runs with the fresh data). Still hidden here, so it's invisible.
    // The backdrop is cosmetic for video — recording is a live stream — but a silent gap
    // would leave region selection running on the live desktop instead of the frozen frame.
    const fail = (reason) => {
        window.api.sendDebugLog('Recorder: capture unusable (' + reason + ') — requesting re-capture');
        window.api.retryCapture();
    };

    // Binary PNG buffer from main — decode via ImageBitmap (no base64/string round-trip).
    if (imageData && imageData.byteLength) {
        createImageBitmap(new Blob([imageData], { type: 'image/png' })).then((bmp) => {
            screenBitmap = bmp; // kept (not closed) so resizeCanvas can repaint from it
            paintScreen();
            finish();
        }).catch((err) => fail('çözümlenemedi: ' + ((err && err.message) || 'bilinmeyen hata')));
    } else if (typeof imageData === 'string' && imageData.length > 100) {
        const img = new Image();
        img.onload = () => {
            screenBitmap = img;
            paintScreen();
            finish();
        };
        img.onerror = () => fail('görüntü yüklenemedi');
        img.src = imageData;
    } else {
        fail('boş görüntü verisi');
    }
});

const dimensionsLabel = document.getElementById('dimensions-label');

function updateDimensions(w, h) {
    if (dimensionsLabel) {
        dimensionsLabel.textContent = `${Math.round(w)} x ${Math.round(h)}`;
    }
}

if (qualitySelect) {
    qualitySelect.addEventListener('change', (e) => {
        state.videoQuality = e.target.value;
        window.api.setVideoQuality(state.videoQuality);
    });
}

// --- Audio toggles (microphone + system/computer audio) ---
function updateAudioButtons() {
    if (btnMic) {
        btnMic.classList.toggle('active', !!state.audioMicOn);
        btnMic.setAttribute('aria-pressed', state.audioMicOn ? 'true' : 'false');
    }
    if (btnSystemAudio) {
        btnSystemAudio.classList.toggle('active', !!state.audioSystemOn);
        btnSystemAudio.setAttribute('aria-pressed', state.audioSystemOn ? 'true' : 'false');
    }
}

// Restore the last-used audio choices so the toolbar remembers them across captures.
if (window.api.getAudioSettings) {
    window.api.getAudioSettings().then((s) => {
        state.audioMicOn = !!(s && s.mic);
        state.audioSystemOn = !!(s && s.system);
        updateAudioButtons();
    }).catch(() => { });
}

if (btnMic) {
    btnMic.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.isRecording) return; // audio sources are locked in once recording starts
        state.audioMicOn = !state.audioMicOn;
        updateAudioButtons();
        if (window.api.setAudioMic) window.api.setAudioMic(state.audioMicOn);
    });
}

if (btnSystemAudio) {
    btnSystemAudio.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.isRecording) return;
        state.audioSystemOn = !state.audioSystemOn;
        updateAudioButtons();
        if (window.api.setAudioSystem) window.api.setAudioSystem(state.audioSystemOn);
    });
}

// Acquire a microphone audio track. On macOS this first ensures TCC permission so a denial
// surfaces clearly instead of throwing a cryptic getUserMedia error.
async function getMicTrack() {
    if (window.api.platform === 'darwin' && window.api.ensureMicPermission) {
        const granted = await window.api.ensureMicPermission();
        if (!granted) {
            throw new Error(t('Mikrofon izni verilmedi. Sistem Ayarları > Gizlilik ve Güvenlik > Mikrofon.'));
        }
    }
    const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    state.micStream = s;
    return s.getAudioTracks()[0] || null;
}

// Acquire a system/computer audio (loopback) track.
//  - Windows: Chromium's desktop-loopback trick. Requesting desktop audio REQUIRES a desktop
//    video request in the same call; we keep the audio track and immediately drop the video.
//  - macOS/Linux: getDisplayMedia, fulfilled by the main process with audio:'loopback'.
async function getSystemAudioTrack() {
    let s;
    if (window.api.platform === 'win32') {
        s = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop' } },
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: state.sourceId } }
        });
    } else {
        s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    }
    s.getVideoTracks().forEach(t => t.stop()); // discard the throwaway video track
    state.sysStream = s;
    return s.getAudioTracks()[0] || null;
}

function systemAudioUnavailableMsg(err) {
    const detail = err && err.message ? ' (' + err.message + ')' : '';
    if (window.api.platform === 'darwin') {
        return t('Sistem sesi kaydedilemedi. macOS\'ta bilgisayar sesini kaydetmek için BlackHole gibi bir sanal ses aygıtı gerekebilir.') + detail;
    }
    return t('Sistem sesi alınamadı.') + detail;
}

// MediaRecorder encodes only ONE audio track, so when both mic and system audio are on we
// mix them into a single track with Web Audio. With a single source we return it untouched
// (no AudioContext needed). Returns null when there is no audio at all.
function mixAudioTracks(tracks) {
    if (!tracks || tracks.length === 0) return null;
    if (tracks.length === 1) return tracks[0];
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    state.audioContext = ctx;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { } }
    const dest = ctx.createMediaStreamDestination();
    tracks.forEach((t) => {
        try { ctx.createMediaStreamSource(new MediaStream([t])).connect(dest); }
        catch (e) { console.error('Audio mix source failed:', e); }
    });
    return dest.stream.getAudioTracks()[0] || null;
}

function stopAudioCapture() {
    try { if (state.micStream) state.micStream.getTracks().forEach(t => t.stop()); } catch (e) { }
    try { if (state.sysStream) state.sysStream.getTracks().forEach(t => t.stop()); } catch (e) { }
    try { if (state.audioContext) state.audioContext.close(); } catch (e) { }
    state.micStream = state.sysStream = state.audioContext = null;
}

function updateIgnoreMouse(e) {
    if (!state.isRecording) return;
    const tr = toolbar.getBoundingClientRect();
    const padding = 20;
    const isOverToolbar = e.clientX >= tr.left - padding && e.clientX <= tr.right + padding &&
        e.clientY >= tr.top - padding && e.clientY <= tr.bottom + padding;

    const shouldIgnore = !isOverToolbar;
    if (shouldIgnore !== state.lastIgnoreState) {
        window.api.setIgnoreMouseEvents(shouldIgnore, { forward: true });
        state.lastIgnoreState = shouldIgnore;
    }
}

window.addEventListener('mousemove', updateIgnoreMouse);

window.addEventListener('mousedown', (e) => {
    if (state.isRecording) return;
    if (e.target.closest('.toolbar')) return;

    if (state.selectionRect) {
        if (e.target.classList.contains('resize-handle')) {
            state.isResizing = true; state.activeHandle = e.target.dataset.handle;
            const b = selectionBox.getBoundingClientRect();
            state.resizeStartRect = { left: b.left, top: b.top, width: b.width, height: b.height };
            state.startX = e.clientX; state.startY = e.clientY;
            document.body.classList.add('selecting');
            return;
        }
        if (e.target === selectionBox) {
            state.isMoving = true;
            const r = selectionBox.getBoundingClientRect();
            state.dragOffX = e.clientX - r.left; state.dragOffY = e.clientY - r.top;
            return;
        }
    }
    window.api.claimCaptureMonitor(); // new selection → clear other monitors' selections
    state.isSelecting = true;
    document.body.classList.add('selecting');
    state.startX = e.clientX; state.startY = e.clientY;
    selectionBox.style.width = selectionBox.style.height = '0px';
    selectionBox.style.left = state.startX + 'px'; selectionBox.style.top = state.startY + 'px';
    selectionBox.style.display = 'block'; selectionBox.classList.remove('hidden');
    overlay.style.display = 'none';
    if (instruction) instruction.style.display = 'none';
    updateDimensions(0, 0);
});

btnFullscreen.addEventListener('click', () => {
    if (state.isRecording) return;
    window.api.claimCaptureMonitor();
    state.selectionRect = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    selectionBox.style.left = '0px'; selectionBox.style.top = '0px';
    selectionBox.style.width = window.innerWidth + 'px'; selectionBox.style.height = window.innerHeight + 'px';
    selectionBox.style.display = 'block'; selectionBox.classList.remove('hidden');
    overlay.style.display = 'none';
    if (instruction) instruction.style.display = 'none';
    updateDimensions(window.innerWidth, window.innerHeight);
});

window.addEventListener('mousemove', (e) => {
    if (state.isRecording) return;
    if (state.isResizing) {
        let dx = e.clientX - state.startX, dy = e.clientY - state.startY;
        let { left, top, width, height } = state.resizeStartRect;
        if (state.activeHandle.includes('e')) width += dx;
        if (state.activeHandle.includes('s')) height += dy;
        if (state.activeHandle.includes('w')) { left += dx; width -= dx; }
        if (state.activeHandle.includes('n')) { top += dy; height -= dy; }
        width = Math.max(50, width);
        height = Math.max(50, height);
        selectionBox.style.width = width + 'px'; selectionBox.style.height = height + 'px';
        selectionBox.style.left = left + 'px'; selectionBox.style.top = top + 'px';
        updateDimensions(width, height);
    } else if (state.isMoving) {
        selectionBox.style.left = Math.max(0, Math.min(e.clientX - state.dragOffX, window.innerWidth - selectionBox.offsetWidth)) + 'px';
        selectionBox.style.top = Math.max(0, Math.min(e.clientY - state.dragOffY, window.innerHeight - selectionBox.offsetHeight)) + 'px';
    } else if (state.isSelecting) {
        const w = Math.abs(e.clientX - state.startX);
        const h = Math.abs(e.clientY - state.startY);
        selectionBox.style.width = w + 'px';
        selectionBox.style.height = h + 'px';
        selectionBox.style.left = Math.min(e.clientX, state.startX) + 'px';
        selectionBox.style.top = Math.min(e.clientY, state.startY) + 'px';
        updateDimensions(w, h);
    }
});

window.addEventListener('mouseup', () => {
    if (state.isRecording) return;
    if (state.isResizing || state.isMoving || state.isSelecting) {
        const r = selectionBox.getBoundingClientRect();
        state.selectionRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    state.isResizing = state.isMoving = state.isSelecting = false;
    document.body.classList.remove('selecting');
});

btnClose.addEventListener('click', () => {
    if (state.isRecording) stopRecording();
    window.api.closeSnipper();
});

async function startRecording() {
    if (!state.selectionRect || !state.sourceId) return;
    try {
        const sx = state.scaleX != null ? state.scaleX : state.dpr;
        const sy = state.scaleY != null ? state.scaleY : state.dpr;
        const videoWidth = state.captureWidth != null ? state.captureWidth : Math.floor(window.innerWidth * state.dpr);
        const videoHeight = state.captureHeight != null ? state.captureHeight : Math.floor(window.innerHeight * state.dpr);

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: state.sourceId,
                    minWidth: videoWidth,
                    maxWidth: videoWidth,
                    minHeight: videoHeight,
                    maxHeight: videoHeight
                }
            }
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        video.play();

        const cropWOriginal = Math.floor(state.selectionRect.w * sx);
        const cropHOriginal = Math.floor(state.selectionRect.h * sy);
        
        // Limit to 4K max to ensure encoder compatibility and performance
        let finalW = Math.min(cropWOriginal, 3840);
        let finalH = Math.min(cropHOriginal, 2160);
        
        // Final dimensions MUST BE EVEN for most encoders (H.264/VP9)
        finalW = (finalW % 2 === 0) ? finalW : Math.max(2, finalW - 1);
        finalH = (finalH % 2 === 0) ? finalH : Math.max(2, finalH - 1);

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = finalW;
        cropCanvas.height = finalH;
        const cropCtx = cropCanvas.getContext('2d');

        cropCtx.imageSmoothingEnabled = false;

        const fps = state.videoQuality === 'ultra' ? 60 : (state.videoQuality === 'high' ? 60 : 30);
        // Optimized bitrates: high enough for quality, low enough for steady encoding
        const bitrate = state.videoQuality === 'ultra' ? 50000000 : (state.videoQuality === 'high' ? 25000000 : (state.videoQuality === 'medium' ? 10000000 : 5000000));

        // Acquire audio BEFORE recording starts so a failure is non-fatal: we warn and keep
        // recording video (+ whatever audio succeeded) instead of losing the whole capture.
        const audioTracks = [];
        const audioWarnings = [];
        if (state.audioMicOn) {
            try {
                const micTrack = await getMicTrack();
                if (micTrack) audioTracks.push(micTrack);
                else audioWarnings.push(t('Mikrofon sesi alınamadı.'));
            } catch (err) {
                audioWarnings.push('Mikrofon sesi alınamadı: ' + (err && err.message ? err.message : err));
            }
        }
        if (state.audioSystemOn) {
            try {
                const sysTrack = await getSystemAudioTrack();
                if (sysTrack) audioTracks.push(sysTrack);
                else audioWarnings.push(systemAudioUnavailableMsg());
            } catch (err) {
                audioWarnings.push(systemAudioUnavailableMsg(err));
            }
        }
        if (audioWarnings.length) alert(audioWarnings.join('\n'));

        // Combine the cropped-canvas video track with the (optional) mixed audio track.
        const mixedAudioTrack = mixAudioTracks(audioTracks);
        const captureStream = cropCanvas.captureStream(fps);
        const recordStream = new MediaStream(captureStream.getVideoTracks());
        if (mixedAudioTrack) recordStream.addTrack(mixedAudioTrack);
        const hasAudio = !!mixedAudioTrack;

        const audioCodec = hasAudio ? ',opus' : '';
        let options = { mimeType: 'video/webm', videoBitsPerSecond: bitrate };
        try {
            // Prefer standard VP9 for high quality / efficiency (add Opus when we have audio)
            if (MediaRecorder.isTypeSupported(`video/webm; codecs=vp9${audioCodec}`)) {
                options = { mimeType: `video/webm; codecs=vp9${audioCodec}`, videoBitsPerSecond: bitrate };
            } else if (MediaRecorder.isTypeSupported(`video/webm; codecs=vp8${audioCodec}`)) {
                options = { mimeType: `video/webm; codecs=vp8${audioCodec}`, videoBitsPerSecond: bitrate };
            }
        } catch (e) { console.error('Option selection failed', e); }
        if (hasAudio) options.audioBitsPerSecond = 128000;

        if (window.api.sendDebugLog) window.api.sendDebugLog(`Starting recording: ${finalW}x${finalH} @ ${fps}fps, ${bitrate/1000000}Mbps, audio: ${hasAudio ? audioTracks.length + ' src' : 'none'}, Mime: ${options.mimeType}`);

        state.mediaRecorder = new MediaRecorder(recordStream, options);

        // blob→ArrayBuffer is async, so a bare `await` in ondataavailable could let the
        // FINAL chunk's IPC slip out after record-stop. Queue every read and have onstop
        // await the queue — IPC from one renderer is FIFO, so once all recordChunk sends
        // are issued, recordStop is guaranteed to arrive after them.
        const pendingChunks = [];
        state.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                pendingChunks.push(
                    e.data.arrayBuffer()
                        .then(buf => window.api.recordChunk(buf))
                        .catch(err => console.error('Chunk read failed:', err))
                );
            }
        };
        state.mediaRecorder.onstop = async () => {
            stopAudioCapture();
            try { await Promise.all(pendingChunks); } catch (err) { }
            window.api.recordStop();
        };

        const drawLoop = () => {
            if (state.isRecording) {
                const r = state.selectionRect;
                // Ensure drawImage source coordinates are within video metadata limits
                const sw = Math.min(Math.floor(r.w * sx), Math.floor(video.videoWidth));
                const sh = Math.min(Math.floor(r.h * sy), Math.floor(video.videoHeight));
                
                if (sw > 0 && sh > 0) {
                    cropCtx.drawImage(video,
                        Math.floor(r.x * sx), Math.floor(r.y * sy), sw, sh,
                        0, 0, cropCanvas.width, cropCanvas.height);
                }
                requestAnimationFrame(drawLoop);
            } else { stream.getTracks().forEach(t => t.stop()); }
        };

        state.isRecording = true;
        window.api.recordStart();
        state.mediaRecorder.start(1000);
        drawLoop();

        document.body.classList.add('is-recording');
        btnRecord.classList.add('hidden');
        btnFullscreen.classList.add('hidden');
        if (btnResetSize) btnResetSize.classList.add('hidden');
        if (qualitySelect) qualitySelect.classList.add('hidden');
        if (qualityLabel) qualityLabel.classList.add('hidden');
        if (btnMic) btnMic.classList.add('hidden');
        if (btnSystemAudio) btnSystemAudio.classList.add('hidden');
        btnStop.classList.remove('hidden');
        timerElement.classList.remove('hidden');
        selectionBox.classList.add('recording-border');

        canvas.style.pointerEvents = 'none';
        overlay.style.display = 'none';
        selectionBox.style.pointerEvents = 'none';
        document.querySelectorAll('.resize-handle').forEach(h => h.style.display = 'none');
        canvas.style.display = 'none';
        overlay.style.display = 'none';

        state.startTime = Date.now();
        state.timerInterval = setInterval(() => {
            const s = Math.floor((Date.now() - state.startTime) / 1000);
            timerElement.textContent = `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
        }, 1000);

        state.lastIgnoreState = true;
        window.api.setIgnoreMouseEvents(true, { forward: true });

    } catch (e) {
        console.error(t('Kayıt hatası:'), e);
        // Surface the failure and reset to a retryable state. The UI changes above only
        // run after a successful setup, so the Record button is still visible here.
        state.isRecording = false;
        state.mediaRecorder = null;
        stopAudioCapture();
        alert('Kayıt başlatılamadı: ' + (e && e.message ? e.message : e));
    }
}

function stopRecording() {
    state.isRecording = false;
    state.mediaRecorder.stop();
    clearInterval(state.timerInterval);
    window.api.setIgnoreMouseEvents(false);
    document.body.classList.remove('is-recording');
    selectionBox.style.display = 'none';
    canvas.style.display = 'block';
    overlay.style.display = 'block';
    selectionBox.style.pointerEvents = 'auto';
    document.querySelectorAll('.resize-handle').forEach(h => h.style.display = 'block');
}

btnRecord.addEventListener('click', startRecording);
function applyDefaultSize() {
    if (state.isRecording) return;
    const w = 500, h = 500;
    const left = Math.floor((window.innerWidth - w) / 2);
    const top = Math.floor((window.innerHeight - h) / 2);

    state.selectionRect = { x: left, y: top, w: w, h: h };
    selectionBox.style.width = w + 'px';
    selectionBox.style.height = h + 'px';
    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.display = 'block';
    selectionBox.classList.remove('hidden');
    overlay.style.display = 'none';
    if (instruction) instruction.style.display = 'none';
    updateDimensions(w, h);
}

const btnResetSize = document.getElementById('btn-reset-size');
if (btnResetSize) {
    btnResetSize.addEventListener('click', applyDefaultSize);
}
btnStop.addEventListener('click', (e) => { e.stopPropagation(); stopRecording(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (state.isRecording) stopRecording(); window.api.closeSnipper(); } });
