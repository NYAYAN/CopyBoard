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

const state = {
    isSelecting: false, isMoving: false, isResizing: false,
    activeHandle: null, resizeStartRect: null, selectionRect: null,
    startX: 0, startY: 0, dragOffX: 0, dragOffY: 0,
    mediaRecorder: null, recordedChunks: [], startTime: 0, timerInterval: null,
    sourceId: null, isRecording: false, videoQuality: 'high', lastIgnoreState: null,
    dpr: window.devicePixelRatio || 1
};

function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    state.dpr = dpr;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

window.api.onCaptureScreen((dataUrl, mode, sourceId, quality) => {
    state.sourceId = sourceId;
    state.videoQuality = quality || 'high';
    if (qualitySelect) qualitySelect.value = state.videoQuality;
    const dpr = state.dpr;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width / dpr, canvas.height / dpr);
        setTimeout(() => window.api.notifyReady(), 50);
    };
    img.src = dataUrl;
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
        const dpr = state.dpr;
        // High DPI: Use physical resolution for better quality
        const videoWidth = Math.floor(window.innerWidth * dpr);
        const videoHeight = Math.floor(window.innerHeight * dpr);

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: state.sourceId,
                    minWidth: videoWidth,
                    minHeight: videoHeight,
                    maxWidth: videoWidth,
                    maxHeight: videoHeight
                }
            }
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        video.play();

        const cropCanvas = document.createElement('canvas');
        // Crop dimensions also need to be physical pixels
        cropCanvas.width = Math.floor(state.selectionRect.w * dpr);
        cropCanvas.height = Math.floor(state.selectionRect.h * dpr);
        const cropCtx = cropCanvas.getContext('2d');

        const fps = state.videoQuality === 'ultra' ? 120 : (state.videoQuality === 'high' ? 60 : 30);
        // Optimized bitrate for High DPI. WebM/VP9 needs enough bitrate for 4K-ish resolutions
        const bitrate = state.videoQuality === 'ultra' ? 120000000 : (state.videoQuality === 'high' ? 80000000 : (state.videoQuality === 'medium' ? 12000000 : 4000000));

        state.mediaRecorder = new MediaRecorder(cropCanvas.captureStream(fps), {
            mimeType: 'video/webm; codecs=vp9',
            videoBitsPerSecond: bitrate
        });

        state.mediaRecorder.ondataavailable = async (e) => {
            if (e.data.size > 0) window.api.recordChunk(await e.data.arrayBuffer());
        };
        state.mediaRecorder.onstop = () => { window.api.recordStop(); };

        const drawLoop = () => {
            if (state.isRecording) {
                // Adjust for High DPI scale while drawing
                cropCtx.drawImage(video,
                    state.selectionRect.x * dpr, state.selectionRect.y * dpr,
                    state.selectionRect.w * dpr, state.selectionRect.h * dpr,
                    0, 0, cropCanvas.width, cropCanvas.height);
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

    } catch (e) { console.error('Kayıt hatası:', e); }
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
const btnResetSize = document.getElementById('btn-reset-size');
if (btnResetSize) {
    btnResetSize.addEventListener('click', () => {
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
    });
}
btnStop.addEventListener('click', (e) => { e.stopPropagation(); stopRecording(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (state.isRecording) stopRecording(); window.api.closeSnipper(); } });
