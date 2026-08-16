import { elements } from './dom.js';
import { confirmAction } from './modals.js';
import { groupKey, shortTime, fullTime } from './content-type.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

// Screenshot gallery: a thumbnail grid fed by the main process's screenshot-library.
// Plain click copies the image (the same gesture as a history row), the corner buttons
// open the large viewer / copy / reveal / delete, right-click opens the native menu.
//
// Those corner buttons used to be painted on permanently — four opaque chips over the
// right-hand third of every thumbnail, so the grid hid more of each screenshot than it
// showed. They live on hover now, and the grid answers to the keyboard like the list does.

const { ICONS: SHARED_ICONS } = window.CopyBoardShared;
const GALLERY_ICONS = {
    zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'
};

// Newest screenshot in the grid — the target for the toolbar's "Büyük Görüntüle", which
// has no per-item selection to work from.
let newestId = null;
let selectedId = null;

const items = () => Array.from(elements.galleryGrid.querySelectorAll('.gallery-item'));
const itemById = (id) => (id
    ? elements.galleryGrid.querySelector(`.gallery-item[data-shot-id="${CSS.escape(id)}"]`)
    : null);

function paint(item, scroll) {
    elements.galleryGrid.querySelectorAll('.gallery-item.selected')
        .forEach(el => el.classList.remove('selected'));
    if (!item) {
        selectedId = null;
        elements.galleryGrid.removeAttribute('aria-activedescendant');
        return;
    }
    selectedId = item.dataset.shotId;
    item.classList.add('selected');
    elements.galleryGrid.setAttribute('aria-activedescendant', item.id);
    if (scroll) item.scrollIntoView({ block: 'nearest' });
}

export function renderGallery(list) {
    const shots = list || [];
    newestId = shots.length ? shots[0].id : null;
    // Gallery-wide actions are pointless with an empty gallery.
    if (elements.galleryViewBtn) elements.galleryViewBtn.disabled = !newestId;
    if (elements.galleryFolderBtn) elements.galleryFolderBtn.disabled = !newestId;

    const grid = elements.galleryGrid;
    grid.innerHTML = '';
    if (elements.galleryCount) {
        elements.galleryCount.textContent = t('{count} görüntü', { count: shots.length });
    }

    if (!shots.length) {
        const empty = document.createElement('div');
        empty.className = 'empty gallery-empty';
        empty.innerHTML = GALLERY_ICONS.empty;
        const h = document.createElement('div');
        h.className = 'empty-title';
        h.textContent = t('Ekran görüntüsü yok');
        const p = document.createElement('div');
        p.className = 'empty-desc';
        p.textContent = t('Ekran görüntüsü aracıyla kopyaladığınız veya kaydettiğiniz resimler burada birikir.');
        empty.appendChild(h);
        empty.appendChild(p);
        grid.appendChild(empty);
        paint(null);
        return;
    }

    const now = new Date();
    const frag = document.createDocumentFragment();

    shots.forEach((shot) => {
        const date = shot.timestamp ? new Date(shot.timestamp) : now;

        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.dataset.shotId = shot.id;
        item.id = `shot-${shot.id}`;
        item.setAttribute('role', 'option');
        item.__shot = shot;
        item.title = `${shot.w}×${shot.h} — ${fullTime(date)}`;

        const img = document.createElement('img');
        img.src = shot.thumb;
        img.alt = t('Ekran görüntüsü');
        img.draggable = false;

        const time = document.createElement('span');
        time.className = 'shot-time';
        time.textContent = shortTime(date, groupKey(date, now), now);

        const actions = document.createElement('div');
        actions.className = 'shot-actions';
        const mkBtn = (cls, act, label, svg, onClick) => {
            const b = document.createElement('button');
            b.className = cls;
            b.dataset.act = act;
            b.title = label;
            b.setAttribute('aria-label', label);
            b.innerHTML = svg;
            b.tabIndex = -1;
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            actions.appendChild(b);
        };
        mkBtn('act-zoom', 'open', t('Büyük Görüntüle'), GALLERY_ICONS.zoom,
            () => window.api.openScreenshotViewer(shot.id));
        mkBtn('act-copy', 'copy', t('Kopyala'), SHARED_ICONS.copy, () => copyShot(item, shot.id));
        mkBtn('act-folder', 'folder', t('Klasörde Göster'), GALLERY_ICONS.folder,
            () => window.api.showScreenshotFile(shot.id));
        mkBtn('act-del', 'delete', t('Sil'), SHARED_ICONS.trash,
            () => window.api.deleteScreenshot(shot.id));

        item.appendChild(img);
        item.appendChild(time);
        item.appendChild(actions);

        item.addEventListener('click', () => copyShot(item, shot.id));
        item.addEventListener('mousedown', () => paint(item, false));
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            window.api.showScreenshotMenu(shot.id);
        });

        frag.appendChild(item);
    });

    grid.appendChild(frag);
    // Keep the cursor on the same screenshot across a refresh; fall back to the newest.
    paint(itemById(selectedId) || items()[0], false);
}

// Plain click = copy, mirroring the history rows. Brief flash as feedback (the toast
// confirms it too).
function copyShot(item, id) {
    window.api.copyScreenshot(id);
    item.classList.add('copied');
    setTimeout(() => item.classList.remove('copied'), 800);
}

function move(delta) {
    const all = items();
    if (!all.length) return;
    const current = itemById(selectedId);
    const i = current ? all.indexOf(current) : -1;
    const next = i === -1
        ? (delta > 0 ? 0 : all.length - 1)
        : Math.max(0, Math.min(all.length - 1, i + delta));
    paint(all[next], true);
}

// A screenshot is a file on disk, and deleting it takes the file. Like removing a
// favourite, the keystroke asks first — the corner button is an aimed click and doesn't.
function removeSelected() {
    const item = itemById(selectedId);
    if (!item) return;
    const shot = item.__shot || {};
    confirmAction({
        title: t('Ekran görüntüsünü sil'),
        text: t('Bu ekran görüntüsü diskten silinecek.'),
        confirmLabel: t('Sil')
    }).then((ok) => {
        if (!ok) return;
        const all = items();
        const current = itemById(shot.id);
        if (!current) return;
        const next = all[all.indexOf(current) + 1] || all[all.indexOf(current) - 1];
        selectedId = next ? next.dataset.shotId : null;
        window.api.deleteScreenshot(shot.id);
    });
}

function onKey(e) {
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;
    if (elements.app.dataset.view !== 'gallery') return;

    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

    // One or two columns — the layout toggle decides, so up/down has to ask.
    const cols = elements.galleryGrid.classList.contains('single') ? 1 : 2;
    const mod = e.metaKey || e.ctrlKey;

    switch (e.key) {
        case 'ArrowRight': e.preventDefault(); move(1); return;
        case 'ArrowLeft': e.preventDefault(); move(-1); return;
        case 'ArrowDown': e.preventDefault(); move(cols); return;
        case 'ArrowUp': e.preventDefault(); move(-cols); return;
        case 'Home': e.preventDefault(); move(-1e6); return;
        case 'End': e.preventDefault(); move(1e6); return;
        case 'Enter': {
            const item = itemById(selectedId);
            if (!item) return;
            e.preventDefault();
            if (mod) window.api.openScreenshotViewer(item.dataset.shotId);
            else copyShot(item, item.dataset.shotId);
            return;
        }
        case 'o':
        case 'O': {
            const item = itemById(selectedId);
            if (!item) return;
            e.preventDefault();
            window.api.openScreenshotViewer(item.dataset.shotId);
            return;
        }
        case 'Backspace':
        case 'Delete':
            e.preventDefault();
            removeSelected();
            return;
        default:
    }
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

    // Toolbar (left): whole-gallery actions, mirroring two of the per-item ones.
    elements.galleryFolderBtn.addEventListener('click', () => window.api.openScreenshotFolder());
    elements.galleryViewBtn.addEventListener('click', () => {
        if (newestId) window.api.openScreenshotViewer(newestId);
    });

    document.addEventListener('keydown', onKey);

    window.api.onScreenshotsUpdated((list) => renderGallery(list));
    window.api.getScreenshots().then(renderGallery);
}
