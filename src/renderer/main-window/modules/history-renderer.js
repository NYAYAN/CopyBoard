import { elements } from './dom.js';
import { openNoteModal } from './notes.js';
import { onDragStart, onDragOver, onDrop } from './drag-drop.js';

// Cached formatters — constructing Intl.DateTimeFormat per item per render is costly
const DATE_FMT = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });

// Shared row-action icons + search predicate come from the classic script loaded before
// renderer.js (see ../shared/render-utils.js and the <script> tag in index.html). ES
// modules can read window globals freely; this keeps the 4 overlapping icons in one place.
const { ICONS: SHARED_ICONS, matchesSearch } = window.CopyBoardShared;

// DISPLAY-only caps: a copied item can be hundreds of KB, and pushing that whole string
// into the DOM per row makes renders crawl. Rows are single-line ellipsized, so ~300
// chars covers any realistic width; the rest shows in the hover tooltip. Copy/search
// always use the full in-memory item.content — only what lands in the DOM is clipped.
const PREVIEW_CHARS = 300;
const TOOLTIP_CHARS = 500;
const TOOLTIP_DELAY_MS = 500;
const clip = (s, max) => (s && s.length > max ? s.slice(0, max) + '…' : s);

// Shared hover tooltip — ONE element for the whole list, its content built only after
// the cursor rests on a row for 500ms. Cheaper than per-row title attributes and shows
// far more of the item than the native tooltip would.
const tooltip = document.createElement('div');
tooltip.className = 'history-tooltip';
document.body.appendChild(tooltip);
let tooltipTimer = null;

function hideTooltip() {
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    tooltip.classList.remove('visible');
}

function scheduleTooltip(content, row) {
    if (tooltipTimer) clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => {
        tooltipTimer = null;
        tooltip.textContent = clip(content, TOOLTIP_CHARS);
        const r = row.getBoundingClientRect();
        // Below the row; flip above when there's no room. Measure AFTER setting text.
        tooltip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 308)) + 'px';
        tooltip.style.top = '0px';
        tooltip.classList.add('visible');
        const th = tooltip.offsetHeight;
        const below = r.bottom + 8;
        tooltip.style.top = (below + th > window.innerHeight - 8 ? Math.max(8, r.top - th - 8) : below) + 'px';
    }, TOOLTIP_DELAY_MS);
}

// The list rebuilds (innerHTML='') on every render — never leave a tooltip orbiting a
// row that no longer exists. Same for scrolling under the cursor.
document.addEventListener('scroll', hideTooltip, { capture: true, passive: true });

// Monochrome inline SVGs (stroke=currentColor) matching the header icon set, so row
// actions render consistently across OSes and don't reflow on state swaps (fixed box).
// The 4 shared icons come from SHARED_ICONS; check/noteAdd/noteEdit are main-window-only.
const ICONS = {
    ...SHARED_ICONS,
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    noteAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>',
    noteEdit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
};

export function renderHistory(history, favorites, activeTab, query = '') {
    hideTooltip(); // rows are about to be torn down
    elements.listElement.innerHTML = '';

    let items = activeTab === 'favorites' ? favorites : history;

    // Search Filter
    if (query) {
        const q = query.toLowerCase();
        items = items.filter(item => matchesSearch(item, q));
    }

    if (!items || items.length === 0) {
        const msg = query ? 'Eşleşen sonuç bulunamadı.' : 'Liste boş.';
        elements.listElement.innerHTML = `<div class="empty-state">${msg}</div>`;
        return;
    }

    // For Tümü tab: build a Set of favorited content strings for quick lookup
    const favoritedContents = new Set(favorites.map(f => f.content));

    items.forEach((item, index) => {
        const itemContent = item.content;
        const itemDate = item.timestamp ? new Date(item.timestamp) : new Date();

        const metaText = `${DATE_FMT.format(itemDate)} ${TIME_FMT.format(itemDate)}`;

        const domItem = document.createElement('div');
        domItem.className = 'history-item';
        domItem.setAttribute('data-list-index', index);
        domItem.addEventListener('mouseenter', () => scheduleTooltip(itemContent, domItem));
        domItem.addEventListener('mouseleave', hideTooltip);
        domItem.addEventListener('mousedown', hideTooltip);

        // Drag handles for favorites (reordering)
        if (activeTab === 'favorites') {
            domItem.classList.add('favorites-tab');
            domItem.dataset.tabContext = 'favorites';
            domItem.dataset.itemId = item.id;
            domItem.setAttribute('draggable', 'true');
            domItem.addEventListener('dragstart', onDragStart);
            domItem.addEventListener('dragover', onDragOver);
            domItem.addEventListener('drop', function (e) { onDrop.call(this, e, favorites, activeTab); });
            domItem.addEventListener('dragend', () => domItem.classList.remove('dragging'));

            const dragHandle = document.createElement('span');
            dragHandle.className = 'drag-handle';
            dragHandle.innerHTML = '⋮⋮';
            domItem.appendChild(dragHandle);
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'history-content';

        const textSpan = document.createElement('span');
        textSpan.className = 'history-text';
        textSpan.textContent = clip(itemContent, PREVIEW_CHARS);

        const metaSpan = document.createElement('small');
        metaSpan.className = 'history-meta';
        metaSpan.textContent = metaText;

        contentDiv.appendChild(textSpan);
        contentDiv.appendChild(metaSpan);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'history-actions';

        // Note button (favorites only)
        if (activeTab === 'favorites') {
            const infoBtn = document.createElement('button');
            infoBtn.className = `action-btn info-btn ${item.note ? 'has-note' : ''}`;
            infoBtn.innerHTML = item.note ? ICONS.noteEdit : ICONS.noteAdd;
            infoBtn.title = item.note ? 'Notu Düzenle' : 'Not Ekle';
            infoBtn.setAttribute('aria-label', item.note ? 'Notu Düzenle' : 'Not Ekle');
            if (item.note) infoBtn.title += `\nNot: ${item.note.substring(0, 50)}${item.note.length > 50 ? '...' : ''}`;
            infoBtn.addEventListener('click', (e) => { e.stopPropagation(); openNoteModal(item); });
            actionsDiv.appendChild(infoBtn);
        }

        // Star button
        const starBtn = document.createElement('button');
        if (activeTab === 'favorites') {
            // In Favoriler: always ⭐, clicking removes from favorites
            starBtn.className = 'action-btn star-btn active';
            starBtn.innerHTML = ICONS.starFilled;
            starBtn.title = 'Favorilerden Çıkar';
            starBtn.setAttribute('aria-label', 'Favorilerden Çıkar');
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.api.removeFromFavorites(item.id);
            });
        } else {
            // In Tümü: show ⭐ if already favorited (by content), ☆ if not
            const isAlreadyFavorited = favoritedContents.has(itemContent);
            starBtn.className = `action-btn star-btn ${isAlreadyFavorited ? 'active' : ''}`;
            starBtn.innerHTML = isAlreadyFavorited ? ICONS.starFilled : ICONS.starOutline;
            starBtn.title = isAlreadyFavorited ? 'Favorilere Zaten Eklendi' : 'Favorilere Ekle';
            starBtn.setAttribute('aria-label', isAlreadyFavorited ? 'Favorilere Zaten Eklendi' : 'Favorilere Ekle');
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!isAlreadyFavorited) {
                    window.api.addToFavorites({ content: item.content, timestamp: item.timestamp });
                }
            });
        }
        actionsDiv.appendChild(starBtn);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn copy-btn';
        copyBtn.innerHTML = ICONS.copy;
        copyBtn.title = 'Kopyala';
        copyBtn.setAttribute('aria-label', 'Kopyala');
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyBtn.innerHTML = ICONS.check;
            setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 800);
            window.api.copyItem(itemContent);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn delete-btn';
        deleteBtn.innerHTML = ICONS.trash;
        deleteBtn.title = activeTab === 'favorites' ? 'Favorilerden Çıkar' : 'Sil';
        deleteBtn.setAttribute('aria-label', activeTab === 'favorites' ? 'Favorilerden Çıkar' : 'Sil');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (activeTab === 'favorites') {
                window.api.removeFromFavorites(item.id);
            } else {
                window.api.deleteHistoryItem(item.id);
            }
        });

        actionsDiv.appendChild(copyBtn);
        actionsDiv.appendChild(deleteBtn);

        domItem.appendChild(contentDiv);
        domItem.appendChild(actionsDiv);

        domItem.addEventListener('click', (e) => {
            if (e.target.closest('.action-btn')) return;
            domItem.classList.add('copied');
            copyBtn.innerHTML = ICONS.check;
            setTimeout(() => {
                domItem.classList.remove('copied');
                copyBtn.innerHTML = ICONS.copy;
            }, 800);
            window.api.copyItem(itemContent);
        });

        elements.listElement.appendChild(domItem);
    });
}
