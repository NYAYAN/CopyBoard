// Video galerisi.
//
// Ekran görüntüsü galerisinden ayrı bir modül, çünkü listelenen şey farklı: bir
// videonun küçük resmi tek başına hangi kayıt olduğunu söylemiyor. Kart, küçük resmin
// yanında ad, süre, boyut ve tarih taşıyor.
//
// Videolar uygulamanın kendi klasöründe DEĞİL, kullanıcının kaydetme panelinde seçtiği
// yerde duruyor; burada tutulan yalnızca bir indeks. Dosya Finder'dan silinirse ana
// süreç onu listeden eliyor, yani burada "kayıp dosya" durumu ele alınmıyor.

import { elements } from './dom.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

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
        card.className = 'video-item' + (i === selected ? ' selected' : '');
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

        card.append(thumb, meta);
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

/// Panel açıkken klavye. `true` dönerse olay tüketilmiştir.
export function handleKey(e) {
    if (!items.length) return false;
    const current = items[selected];
    switch (e.key) {
        case 'ArrowDown':
            selected = Math.min(selected + 1, items.length - 1);
            render();
            return true;
        case 'ArrowUp':
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
            // Ctrl/Cmd + Backspace dosyayı da siler; tek başına yalnız listeden düşürür.
            // Ayrım bilinçli: kullanıcının kendi seçtiği klasördeki dosyayı sessizce
            // silmek, listeyi temizlemekle aynı şey değil.
            if (current) window.api.deleteVideo(current.id, e.metaKey || e.ctrlKey);
            return true;
        default:
            return false;
    }
}

export function refresh() {
    if (!window.api.getVideos) return;
    window.api.getVideos().then(setVideos);
}
