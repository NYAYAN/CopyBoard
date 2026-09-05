// Video galerisi.
//
// Ekran görüntüsü galerisinden ayrı bir modül, çünkü listelenen şey farklı: bir
// videonun küçük resmi tek başına hangi kayıt olduğunu söylemiyor. Kart, küçük resmin
// yanında ad, süre, boyut ve tarih taşıyor.
//
// Kayıtlar uygulamanın kendi `videos/` klasörüne yazılıyor ve burada bir indeksle
// listeleniyor. Dosya Finder'dan silinirse ana süreç onu listeden eliyor, yani burada
// "kayıp dosya" durumu ele alınmıyor.
//
// Silme ONAY İSTİYOR: kayıt uygulamanın kendi klasöründe olduğu için dosya da gidiyor
// ve geri alınamıyor. Ekran görüntüsü galerisi de aynı sebeple soruyor.

import { elements } from './dom.js';
import { confirmAction } from './modals.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

// Kart düğmelerinin simgeleri. Galeri modülündeki setle aynı çizgide (2px kontur,
// yuvarlak uç) — iki ızgara yan yana durduğu için ayrışmaları göze batardı.
const ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5v15l12-7.5z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
};

let items = [];
let selected = 0;

function fmtDuration(sec) {
    if (!sec || sec < 0) return '';
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function setVideos(list) {
    items = Array.isArray(list) ? list : [];
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
    render();
}

export function render() {
    const grid = elements.videosGrid;
    if (!grid) return;
    grid.innerHTML = '';

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = t('Henüz video kaydı yok.');
        grid.appendChild(empty);
        if (elements.videosCount) elements.videosCount.textContent = '';
        return;
    }

    items.forEach((v, i) => {
        const card = document.createElement('div');
        card.className = 'gallery-item video-item' + (i === selected ? ' selected' : '');
        card.setAttribute('role', 'option');
        card.setAttribute('aria-selected', String(i === selected));
        card.dataset.id = v.id;

        const thumb = document.createElement('div');
        thumb.className = 'video-thumb' + (v.thumb ? '' : ' empty');
        if (v.thumb) {
            const img = document.createElement('img');
            img.src = v.thumb;
            img.alt = '';
            thumb.appendChild(img);
        }
        const dur = fmtDuration(v.duration);
        if (dur) {
            const badge = document.createElement('span');
            badge.className = 'video-dur';
            badge.textContent = dur;
            thumb.appendChild(badge);
        }

        const meta = document.createElement('div');
        meta.className = 'video-meta';
        const name = document.createElement('div');
        name.className = 'video-name';
        name.textContent = v.name || '';
        name.title = v.file || '';
        const sub = document.createElement('div');
        sub.className = 'video-sub';
        sub.textContent = [fmtSize(v.bytes), v.w && v.h ? `${v.w}×${v.h}` : '', fmtDate(v.timestamp)]
            .filter(Boolean)
            .join(' · ');
        meta.append(name, sub);

        // ── Kart üstü düğmeler ────────────────────────────────────────────
        // Ekran görüntüsü galerisiyle aynı desen: normalde gizli, kartın üstüne
        // gelince beliriyor. Kalıcı olsalar küçük resmin üstünü kapatırlardı.
        const actions = document.createElement('div');
        actions.className = 'shot-actions';
        const mkBtn = (act, label, svg, onClick) => {
            const b = document.createElement('button');
            b.dataset.act = act;
            b.title = label;
            b.setAttribute('aria-label', label);
            b.innerHTML = svg;
            b.tabIndex = -1;
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            actions.appendChild(b);
        };
        mkBtn('play', t('Oynat'), ICONS.play, () => window.api.openVideo(v.id));
        mkBtn('folder', t('Klasörde Göster'), ICONS.folder, () => window.api.revealVideo(v.id));
        mkBtn('delete', t('Sil'), ICONS.trash, () => askDelete(v));

        card.append(thumb, meta, actions);
        card.addEventListener('click', () => {
            selected = i;
            render();
        });
        card.addEventListener('dblclick', () => window.api.openVideo(v.id));
        grid.appendChild(card);
    });

    if (elements.videosCount) {
        elements.videosCount.textContent = `${items.length} ${t('video')}`;
    }
    grid.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

// Silmeden önce sor. Video uygulamanın kendi klasöründe duruyor, yani "listeden
// çıkar" ile "dosyayı sil" aynı şey — geri dönüşü yok.
function askDelete(v) {
    if (!v) return;
    confirmAction({
        title: t('Videoyu sil'),
        text: t('Bu kayıt diskten silinecek.'),
        confirmLabel: t('Sil'),
    }).then((ok) => {
        if (ok) window.api.deleteVideo(v.id, true);
    });
}

/// Panel açıkken klavye. `true` dönerse olay tüketilmiştir.
export function handleKey(e) {
    if (!items.length) return false;
    const current = items[selected];
    switch (e.key) {
        // Izgara bir veya iki sütunlu olabiliyor, o yüzden yukarı/aşağı sabit 1 değil
        // SÜTUN SAYISI kadar atlıyor — tek sütunda da doğru çalışıyor.
        case 'ArrowDown':
            selected = Math.min(selected + columns(), items.length - 1);
            render();
            return true;
        case 'ArrowUp':
            selected = Math.max(selected - columns(), 0);
            render();
            return true;
        case 'ArrowRight':
            selected = Math.min(selected + 1, items.length - 1);
            render();
            return true;
        case 'ArrowLeft':
            selected = Math.max(selected - 1, 0);
            render();
            return true;
        case 'Enter':
            if (current) window.api.openVideo(current.id);
            return true;
        case 'f':
        case 'F':
            if (current) window.api.revealVideo(current.id);
            return true;
        case 'Backspace':
        case 'Delete':
            askDelete(current);
            return true;
        default:
            return false;
    }
}

function columns() {
    return elements.videosGrid?.classList.contains('single') ? 1 : 2;
}

// Araç çubuğu: sütun düzeni ve seçili kayda kısayollar.
export function initVideos() {
    // Varsayılan TEK sütun: yatay kart ada, süreye ve tarihe yer bırakıyor; video
    // listesinde bunlar küçük resmin kendisi kadar ayırt edici.
    const DEFAULT_COLS = 1;
    // Anahtar sürümlü: önceki yapı açılışta da yazıyordu, yani depodaki değer
    // kullanıcının SEÇİMİ değil kodun kendi ilk hâliydi. Yeni anahtar o kalıntıyı
    // yok sayıyor.
    const KEY = 'videosLayout.v2';

    const applyLayout = (cols, persist) => {
        elements.videosGrid?.classList.toggle('single', cols === 1);
        elements.videosLayout1?.classList.toggle('active', cols === 1);
        elements.videosLayout2?.classList.toggle('active', cols !== 1);
        // Yalnız kullanıcı tıkladığında yazılıyor. İlk uygulamada da yazsaydı
        // varsayılan anında "seçim" hâline gelir ve bir daha değiştirilemezdi.
        if (persist) {
            try { localStorage.setItem(KEY, String(cols)); } catch (e) { }
        }
    };
    elements.videosLayout1?.addEventListener('click', () => applyLayout(1, true));
    elements.videosLayout2?.addEventListener('click', () => applyLayout(2, true));

    let saved = DEFAULT_COLS;
    try {
        const v = parseInt(localStorage.getItem(KEY), 10);
        if (v === 1 || v === 2) saved = v;
    } catch (e) { }
    applyLayout(saved, false);

    elements.videosPlayBtn?.addEventListener('click', () => {
        const v = items[selected];
        if (v) window.api.openVideo(v.id);
    });
    elements.videosFolderBtn?.addEventListener('click', () => {
        const v = items[selected];
        if (v) window.api.revealVideo(v.id);
    });
}

export function refresh() {
    if (!window.api.getVideos) return;
    window.api.getVideos().then(setVideos);
}
