import { elements } from './dom.js';
import { openNoteModal } from './notes.js';
import { onDragStart, onDragOver, onDragLeave, onDrop } from './drag-drop.js';
import { showTooltipAt, hideTooltip } from './tooltip.js';
import {
    classify, cssColor, iconFor, MONO_TYPES, previewText, clip,
    groupKey, GROUP_LABELS, shortTime, fullTime
} from './content-type.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

// Shared row-action icons + the search predicate come from the classic script loaded
// before renderer.js (see ../shared/render-utils.js). ES modules can read window globals
// freely; this keeps the icons the widget also uses in one place.
const { ICONS: SHARED_ICONS, matchesSearch, fold } = window.CopyBoardShared;

// DISPLAY-only caps. A copied item can be hundreds of KB and pushing that whole string
// into the DOM per row makes renders crawl. Rows are single-line and ellipsized, so this
// covers any realistic width; the rest shows in the hover tooltip. Copy and search always
// use the full in-memory item.content — only what lands in the DOM is clipped.
const PREVIEW_CHARS = 220;
const TOOLTIP_CHARS = 500;
const TOOLTIP_DELAY_MS = 500;
// Row actions are deliberate targets, not something crossed on the way to a row, so they
// reveal faster than the row's content preview.
const ACTION_TOOLTIP_DELAY_MS = 250;

const ICONS = {
    ...SHARED_ICONS,
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    noteAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    noteDot: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>',
    grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    emptyClipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
    emptyStar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    emptySearch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2"/></svg>'
};

// Label a row action. Deliberately no title= : initTooltips skips everything inside a row
// (rows own their content preview), and a native tooltip would be drawn behind this
// always-on-top window anyway. Each button drives the in-page tooltip itself, anchored to
// its own rect, while aria-label carries the same text for screen readers.
function labelAction(btn, label, tipText = label) {
    btn.setAttribute('aria-label', label);
    btn.addEventListener('mouseenter', () => {
        hideTooltip(); // drop the row preview so the two tooltips never fight
        showTooltipAt(tipText, btn.getBoundingClientRect(), ACTION_TOOLTIP_DELAY_MS);
    });
    btn.addEventListener('mouseleave', hideTooltip);
}

// `act` is the keyboard layer's handle on the button — Enter, Ctrl+Backspace and Ctrl+D
// find their target with [data-act], so a shortcut and a click run the identical path
// (including the copy flash) instead of two implementations that can drift.
function mkAction(act, cls, icon, label, onClick, tipText) {
    const b = document.createElement('button');
    b.className = `action-btn ${cls}`;
    b.dataset.act = act;
    b.innerHTML = icon;
    b.tabIndex = -1; // the list is driven by arrow keys; Tab shouldn't walk 150 buttons
    labelAction(b, label, tipText);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
    return b;
}

function emptyState(icon, title, desc) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = icon;
    const h = document.createElement('div');
    h.className = 'empty-title';
    h.textContent = title;
    const p = document.createElement('div');
    p.className = 'empty-desc';
    p.textContent = desc;
    el.appendChild(h);
    el.appendChild(p);
    return el;
}

function flash(row, copyBtn) {
    row.classList.add('copied');
    if (copyBtn) copyBtn.innerHTML = ICONS.check;
    setTimeout(() => {
        row.classList.remove('copied');
        if (copyBtn) copyBtn.innerHTML = ICONS.copy;
    }, 800);
}

export function renderHistory(history, favorites, activeTab, query = '') {
    hideTooltip(); // the rows about to be torn down may own the visible one
    const list = elements.listElement;
    list.innerHTML = '';

    const isFav = activeTab === 'favorites';
    let items = isFav ? favorites : history;

    if (query) {
        // Folded once here, not per item — see CopyBoardShared.fold for why plain
        // lowercasing cannot match Turkish.
        const q = fold(query);
        items = items.filter(item => matchesSearch(item, q));
    }

    updateStatus(items.length, query);

    if (!items.length) {
        list.appendChild(query
            ? emptyState(ICONS.emptySearch, t('Sonuç yok'), t('“{query}” ile eşleşen bir kayıt bulunamadı.', { query }))
            : isFav
                ? emptyState(ICONS.emptyStar, t('Favori yok'), t('Bir satırın yıldızına dokunarak favorilerinize ekleyin.'))
                : emptyState(ICONS.emptyClipboard, t('Geçmiş boş'), t('Kopyaladığınız metinler burada birikir.')));
        list.dispatchEvent(new CustomEvent('list:rendered'));
        return;
    }

    // Favorites are hand-ordered by drag, and a search result is already its own answer —
    // day headings would only get in the way of both.
    const grouped = !isFav && !query;
    const now = new Date();
    const favoriteContents = new Set(favorites.map(f => f.content));

    const frag = document.createDocumentFragment();
    let lastGroup = null;

    items.forEach((item) => {
        const content = item.content;
        const date = item.timestamp ? new Date(item.timestamp) : now;
        const key = groupKey(date, now);

        if (grouped && key !== lastGroup) {
            lastGroup = key;
            const head = document.createElement('div');
            head.className = 'list-group';
            head.textContent = t(GROUP_LABELS[key]);
            frag.appendChild(head);
        }

        const row = document.createElement('div');
        row.className = 'row';
        row.dataset.itemId = item.id;
        row.id = `row-${item.id}`; // the list points aria-activedescendant at this
        row.setAttribute('role', 'option');
        row.__item = item; // the keyboard layer acts on rows, and needs the item behind one

        // The row can only show one line; the tooltip keeps the breaks, and carries the
        // full stamp the row's short time deliberately leaves out.
        const tip = `${clip(content, TOOLTIP_CHARS)}\n\n${fullTime(date)}`;
        row.addEventListener('mouseenter', () => showTooltipAt(tip, row.getBoundingClientRect(), TOOLTIP_DELAY_MS));
        row.addEventListener('mouseleave', hideTooltip);
        row.addEventListener('mousedown', hideTooltip);

        if (isFav) {
            row.classList.add('favorites-tab');
            row.dataset.tabContext = 'favorites';
            row.setAttribute('draggable', 'true');
            row.addEventListener('dragstart', onDragStart);
            row.addEventListener('dragover', onDragOver);
            row.addEventListener('dragleave', onDragLeave);
            row.addEventListener('drop', function (e) { onDrop.call(this, e, favorites, activeTab); });
            row.addEventListener('dragend', () => {
                row.classList.remove('dragging');
                list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
            });

            const handle = document.createElement('span');
            handle.className = 'drag-handle';
            handle.innerHTML = ICONS.grip;
            row.appendChild(handle);
        }

        // Leading glyph — or, for a colour, the colour itself.
        const type = classify(content);
        const icon = document.createElement('span');
        icon.className = 'row-icon';
        const colour = type === 'color' ? cssColor(content) : null;
        if (colour) {
            const swatch = document.createElement('span');
            swatch.className = 'row-swatch';
            // Set through the CSSOM, not a style= attribute: this window's CSP has no
            // 'unsafe-inline' for styles.
            swatch.style.background = colour;
            icon.appendChild(swatch);
        } else {
            icon.innerHTML = iconFor(type);
        }
        row.appendChild(icon);

        const text = document.createElement('span');
        text.className = MONO_TYPES.has(type) ? 'row-text mono' : 'row-text';
        text.textContent = previewText(content, PREVIEW_CHARS);
        row.appendChild(text);

        if (item.note) {
            const dot = document.createElement('span');
            dot.className = 'row-note';
            dot.innerHTML = ICONS.noteDot;
            dot.setAttribute('aria-label', t('Notu var'));
            row.appendChild(dot);
        }

        // Trailing slot: the timestamp, replaced in place by the actions on hover. Fixed
        // width, so the swap never re-flows the text beside it.
        const trail = document.createElement('div');
        trail.className = 'row-trail';

        const time = document.createElement('span');
        time.className = 'row-time';
        time.textContent = shortTime(date, key, now);
        trail.appendChild(time);

        const actions = document.createElement('div');
        actions.className = 'row-actions';

        const copyBtn = mkAction('copy', 'copy', ICONS.copy, t('Kopyala'),
            (b) => { flash(row, b); window.api.copyItem(content); });

        if (isFav) {
            const label = item.note ? t('Notu Düzenle') : t('Not Ekle');
            actions.appendChild(mkAction(
                'note', `note ${item.note ? 'on' : ''}`, ICONS.noteAdd, label,
                () => { hideTooltip(); openNoteModal(item); },
                item.note ? clip(item.note, TOOLTIP_CHARS) : label
            ));
            actions.appendChild(copyBtn);
            // One button for "no longer a favourite". The old row carried both a star and
            // a trash can here, wired to the very same call.
            actions.appendChild(mkAction('delete', 'star on', SHARED_ICONS.starFilled,
                t('Favorilerden Çıkar'), () => window.api.removeFromFavorites(item.id)));
        } else {
            const starred = favoriteContents.has(content);
            actions.appendChild(mkAction(
                'star', `star ${starred ? 'on' : ''}`,
                starred ? SHARED_ICONS.starFilled : SHARED_ICONS.starOutline,
                starred ? t('Favorilerde') : t('Favorilere Ekle'),
                () => { if (!starred) window.api.addToFavorites({ content, timestamp: item.timestamp }); }
            ));
            actions.appendChild(copyBtn);
            actions.appendChild(mkAction('delete', 'delete', ICONS.trash, t('Sil'),
                () => window.api.deleteHistoryItem(item.id)));
        }

        trail.appendChild(actions);
        row.appendChild(trail);

        row.addEventListener('click', (e) => {
            if (e.target.closest('.action-btn')) return;
            flash(row, copyBtn);
            window.api.copyItem(content);
        });

        frag.appendChild(row);
    });

    list.appendChild(frag);
    // The keyboard layer restores its selection off this — it survives a re-render by
    // item id, so a clipboard update arriving mid-navigation doesn't move the cursor.
    list.dispatchEvent(new CustomEvent('list:rendered'));
}

function updateStatus(count, query) {
    const el = elements.statusCount;
    if (!el) return;
    el.textContent = query
        ? t('{count} sonuç', { count })
        : t('{count} öğe', { count });
}
