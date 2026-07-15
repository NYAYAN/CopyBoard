import { elements } from './dom.js';

// Screenshot gallery panel: a thumbnail grid of past screenshots (fed by the main
// process's screenshot-library) with a full-size preview + copy/show/delete actions.

let previewId = null;

function fmtTime(iso) {
    try {
        return new Date(iso).toLocaleString('tr-TR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    } catch (e) {
        return '';
    }
}

export function renderGallery(list) {
    const shots = list || [];
    const grid = elements.galleryGrid;
    grid.innerHTML = '';

    if (shots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'gallery-empty';
        empty.textContent = 'Henüz ekran görüntüsü yok. Ekran görüntüsü aracıyla kopyaladığınız veya kaydettiğiniz resimler burada birikir.';
        grid.appendChild(empty);
        return;
    }

    shots.forEach((shot) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.title = `${shot.w}×${shot.h} — büyütmek için tıklayın`;

        const img = document.createElement('img');
        img.src = shot.thumb;
        img.alt = 'Ekran görüntüsü';

        const time = document.createElement('div');
        time.className = 'gallery-item-time';
        time.textContent = fmtTime(shot.timestamp);

        item.appendChild(img);
        item.appendChild(time);
        item.addEventListener('click', () => openPreview(shot));
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            window.api.showScreenshotMenu(shot.id);
        });
        grid.appendChild(item);
    });
}

async function openPreview(shot) {
    const full = await window.api.getScreenshotFull(shot.id);
    if (!full) return; // file missing — the next update broadcast will refresh the grid
    previewId = shot.id;
    elements.galleryPreviewImg.src = full;
    elements.galleryPreviewMeta.textContent = `${shot.w}×${shot.h} • ${fmtTime(shot.timestamp)}`;
    elements.galleryGrid.classList.add('hidden');
    elements.galleryPreview.classList.remove('hidden');
}

export function closeGalleryPreview() {
    previewId = null;
    elements.galleryPreviewImg.src = '';
    elements.galleryPreview.classList.add('hidden');
    elements.galleryGrid.classList.remove('hidden');
}

export function initGallery() {
    elements.galleryBackBtn.addEventListener('click', closeGalleryPreview);
    elements.galleryCopyBtn.addEventListener('click', () => {
        if (previewId) window.api.copyScreenshot(previewId);
    });
    elements.galleryFolderBtn.addEventListener('click', () => {
        if (previewId) window.api.showScreenshotFile(previewId);
    });
    elements.galleryDeleteBtn.addEventListener('click', () => {
        if (previewId) {
            window.api.deleteScreenshot(previewId);
            closeGalleryPreview(); // the grid refreshes via the screenshots-updated broadcast
        }
    });

    window.api.onScreenshotsUpdated((list) => renderGallery(list));
    window.api.getScreenshots().then(renderGallery);
}
