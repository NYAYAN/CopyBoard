// Large screenshot viewer: shows one full-resolution capture in its own resizable
// window. The main process sends 'viewer-list' (filmstrip thumbnails) and
// 'viewer-image' (data URL + meta) on open and on every navigation.

const stage = document.getElementById('viewer-stage');
const img = document.getElementById('viewer-img');
const title = document.getElementById('viewer-title');
const strip = document.getElementById('viewer-strip');
const prevBtn = document.getElementById('nav-prev');
const nextBtn = document.getElementById('nav-next');

let shotId = null;
let stripKey = ''; // id fingerprint of the rendered strip — skip rebuilds when unchanged

function fmtTime(iso) {
    try {
        return new Date(iso).toLocaleString('tr-TR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    } catch (e) {
        return '';
    }
}

// Zoom-to-actual-size only makes sense when the image doesn't already fit.
function updateZoomable() {
    const zoomable = img.naturalWidth > stage.clientWidth || img.naturalHeight > stage.clientHeight;
    stage.classList.toggle('zoomable', zoomable);
    if (!zoomable) stage.classList.remove('zoomed');
}

function markActiveThumb() {
    let active = null;
    strip.querySelectorAll('img').forEach(t => {
        const on = t.dataset.id === shotId;
        t.classList.toggle('active', on);
        if (on) active = t;
    });
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

window.api.onViewerList((list) => {
    const key = (list || []).map(s => s.id).join(',');
    if (key === stripKey) { markActiveThumb(); return; } // same set — keep DOM, avoid flicker
    stripKey = key;
    strip.innerHTML = '';
    (list || []).forEach(s => {
        const t = document.createElement('img');
        t.src = s.thumb;
        t.alt = 'küçük resim';
        t.dataset.id = s.id;
        t.addEventListener('click', () => window.api.viewerSelect(s.id));
        strip.appendChild(t);
    });
    markActiveThumb();
});

window.api.onViewerImage((data) => {
    shotId = data.id;
    stage.classList.remove('zoomed');
    img.src = data.dataUrl;

    const parts = [`${data.w}×${data.h}`, fmtTime(data.timestamp)];
    if (data.pos && data.total) parts.push(`${data.pos} / ${data.total}`);
    title.textContent = parts.join('  •  ');

    prevBtn.disabled = !(data.pos > 1);
    nextBtn.disabled = !(data.pos && data.total && data.pos < data.total);
    markActiveThumb();
});

img.addEventListener('load', updateZoomable);
window.addEventListener('resize', updateZoomable);

img.addEventListener('click', () => {
    if (stage.classList.contains('zoomable')) stage.classList.toggle('zoomed');
});

prevBtn.addEventListener('click', () => window.api.viewerNav('prev'));
nextBtn.addEventListener('click', () => window.api.viewerNav('next'));

document.getElementById('copy-btn').addEventListener('click', () => {
    if (shotId) window.api.copyScreenshot(shotId);
});
document.getElementById('folder-btn').addEventListener('click', () => {
    if (shotId) window.api.showScreenshotFile(shotId);
});
document.getElementById('close-btn').addEventListener('click', () => window.api.viewerClose());

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.api.viewerClose();
    else if (e.key === 'ArrowLeft') window.api.viewerNav('prev');
    else if (e.key === 'ArrowRight') window.api.viewerNav('next');
});
