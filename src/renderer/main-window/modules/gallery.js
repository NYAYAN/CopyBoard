import { elements } from './dom.js';

// Screenshot gallery panel: a thumbnail grid of past screenshots (fed by the main
// process's screenshot-library). Every action lives on the grid itself — plain
// click copies the image (the same gesture as the history rows), the corner
// buttons open the large viewer / copy / reveal / delete, right-click opens the
// native menu. The old in-panel detail preview is gone; the large viewer window
// replaced it.

// copy/trash come from the shared icon set (also used by the history rows);
// zoom/folder are gallery-only.
const { ICONS: SHARED_ICONS } = window.CopyBoardShared;
const GALLERY_ICONS = {
    zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
};

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
        item.title = `${shot.w}×${shot.h} — kopyalamak için tıklayın`;

        const img = document.createElement('img');
        img.src = shot.thumb;
        img.alt = 'Ekran görüntüsü';

        const time = document.createElement('div');
        time.className = 'gallery-item-time';
        time.textContent = fmtTime(shot.timestamp);

        // Corner action column: large viewer, copy, show in folder, delete.
        // stopPropagation so the item's own click (copy) doesn't also fire.
        const actions = document.createElement('div');
        actions.className = 'gallery-item-actions';
        const mkBtn = (cls, label, svg, onClick) => {
            const b = document.createElement('button');
            b.className = cls;
            b.title = label;
            b.setAttribute('aria-label', label);
            b.innerHTML = svg;
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            actions.appendChild(b);
        };
        mkBtn('act-zoom', 'Büyük Görüntüle', GALLERY_ICONS.zoom, () => window.api.openScreenshotViewer(shot.id));
        mkBtn('act-copy', 'Kopyala', SHARED_ICONS.copy, () => window.api.copyScreenshot(shot.id));
        mkBtn('act-folder', 'Klasörde Göster', GALLERY_ICONS.folder, () => window.api.showScreenshotFile(shot.id));
        mkBtn('act-del', 'Sil', SHARED_ICONS.trash, () => window.api.deleteScreenshot(shot.id));

        item.appendChild(img);
        item.appendChild(time);
        item.appendChild(actions);

        // Plain click = copy, mirroring the history rows. Brief green flash as feedback
        // (the toast confirms it too).
        item.addEventListener('click', () => {
            window.api.copyScreenshot(shot.id);
            item.classList.add('copied');
            setTimeout(() => item.classList.remove('copied'), 800);
        });
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            window.api.showScreenshotMenu(shot.id);
        });
        grid.appendChild(item);
    });
}

export function initGallery() {
    // 1- or 2-column grid — a pure UI preference, persisted in localStorage.
    const applyLayout = (cols) => {
        elements.galleryGrid.classList.toggle('single', cols === 1);
        elements.galleryLayout1.classList.toggle('active', cols === 1);
        elements.galleryLayout2.classList.toggle('active', cols !== 1);
        try { localStorage.setItem('galleryLayout', String(cols)); } catch (e) { }
    };
    elements.galleryLayout1.addEventListener('click', () => applyLayout(1));
    elements.galleryLayout2.addEventListener('click', () => applyLayout(2));
    let saved = 2;
    try { saved = parseInt(localStorage.getItem('galleryLayout'), 10) || 2; } catch (e) { }
    applyLayout(saved);

    window.api.onScreenshotsUpdated((list) => renderGallery(list));
    window.api.getScreenshots().then(renderGallery);
}
