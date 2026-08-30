const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
const mainBtn = document.getElementById('widget-main');
const menu = document.getElementById('widget-menu');
const btnSnippet = document.getElementById('btn-snippet');
const btnScreenshot = document.getElementById('btn-screenshot');
const btnOcr = document.getElementById('btn-ocr');
const btnVideo = document.getElementById('btn-video');
const btnScroll = document.getElementById('btn-scroll');
const btnOpenMain = document.getElementById('btn-open-main');
const historyPanel = document.getElementById('history-panel');
const historyItemsContainer = document.getElementById('history-items');
const tabHistory = document.getElementById('tab-history');
const tabFavorites = document.getElementById('tab-favorites');

const widgetSearch = document.getElementById('widget-search');

// Monochrome SVGs for the history-row actions (matches the main-window icon set) and the
// list search predicate — both come from the shared classic script loaded before this one
// (see ../shared/render-utils.js and the <script> tag in widget.html). The widget's row
// actions use exactly the 4 shared icons, so ICONS is that shared set verbatim.
const { ICONS, matchesSearch, fold } = window.CopyBoardShared;

// DISPLAY-only caps: rows and the hover tooltip clip what goes into the DOM — a copied
// item can be hundreds of KB. Copy/search always use the full in-memory item.content.
// Rows are single-line ellipsized, so ~300 chars covers any width.
const PREVIEW_CHARS = 220;
const TOOLTIP_CHARS = 500;
const TOOLTIP_DELAY_MS = 500;
// Shorter than the history-row delay: these are icon-only buttons, so the label is the
// only way to tell them apart and waiting half a second to find out is too slow.
const BTN_TOOLTIP_DELAY_MS = 300;

// Content classification, row-text clipping and time formatting are shared with the main
// window and the quick-paste picker (see ../shared/content-type.js) — three windows render
// rows of clipboard entries and they should not each have their own idea of what a URL
// looks like or how to write a timestamp.
const C = window.CopyBoardContent;

// The panel is 350px wide, so the row can't spell out a full date. It shows what the
// main window's day headings would otherwise have said: a clock time for today and
// yesterday, a weekday name this week, a date before that.
const formatMeta = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const now = new Date();
    return C.shortTime(d, C.groupKey(d, now), now);
};

let isOpen = false;
let isHistoryOpen = false;
let isDragging = false;
let isPointerDown = false;
let dragStartX, dragStartY;
let collapseTimeout = null;
let historyTimeout = null;
let lastHistoryRequestId = 0;
let activeTab = 'history'; // 'history' | 'favorites'
let allHistoryItems = [];
let allFavoriteItems = [];
let favoritedContentsSet = new Set(); // rebuilt on data change, not per scroll frame
let searchQuery = '';
let currentOpacity = 1;
let lastDragEndTime = 0;
let scrollRaf = null;

// Opacity event listeners for main button
mainBtn.addEventListener('mouseenter', () => {
    mainBtn.style.opacity = '1';
});

mainBtn.addEventListener('mouseleave', () => {
    if (!isOpen && !isHistoryOpen && !isDragging) {
        mainBtn.style.opacity = currentOpacity.toString();
    }
});

// --- Circular hit-test ---
// Only the visible round button is interactive. The square corners around the
// circle — and everything just outside the disc — stay click-through, so a click
// there falls to the app underneath instead of triggering the widget.
//
// HIT_MARGIN is extra radius (px) added around a button's visible edge when deciding
// "on the button" (capture) vs "click-through". 0 = the capture area matches the
// visible circle exactly; a positive value creates an invisible ring around the
// button that also swallows clicks meant for the app behind it.
const HIT_MARGIN = 0;

function isOverMainButton(clientX, clientY, margin = HIT_MARGIN) {
    const rect = mainBtn.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2 + margin;
    const dx = clientX - cx;
    const dy = clientY - cy;
    return dx * dx + dy * dy <= radius * radius;
}

// --- Tıklama geçirgenliği: karar Rust'ta, geometri burada -------------------
//
// Electron `setIgnoreMouseEvents(true, { forward: true })` sunuyordu — pencere
// tıklama-geçirgen oluyor AMA mousemove almaya devam ediyordu, ve widget bu iletilen
// hareketlerle imlecin bir düğmeye geldiğini görüp geçirgenliği kaldırıyordu.
//
// Tauri'de `forward` yok ve macOS'ta geçirgen bir pencere HİÇ mousemove almıyor.
// O modelle widget kalıcı olarak tıklanamaz kalıyordu.
//
// Yeni bölüşüm: burası yalnız YÜZEY GEOMETRİSİNİ bildiriyor (yuvarlak düğmeler +
// açık panel dikdörtgeni); imleci ana süreç yokluyor ve geçirgenliği o açıp kapatıyor.
// Kullanıcıya görünen davranış birebir aynı.

// Yüzeyleri topla. Koordinatlar CSS pikseli (client) — ana süreç zoom'u hesaba katıyor.
function collectHitAreas() {
    // Sürükleme/basılı tutma sırasında TÜM pencere yakalasın ki hareket kaybolmasın.
    if (isDragging || isPointerDown) return [{ kind: 'everything' }];

    const areas = [];
    if (isHistoryOpen) {
        const p = historyPanel.getBoundingClientRect();
        if (p.width > 0 && p.height > 0) {
            areas.push({ kind: 'rect', x: p.left, y: p.top, w: p.width, h: p.height });
        }
    }
    const m = mainBtn.getBoundingClientRect();
    if (m.width > 0) {
        areas.push({
            kind: 'circle',
            cx: m.left + m.width / 2,
            cy: m.top + m.height / 2,
            r: m.width / 2 + HIT_MARGIN,
        });
    }
    if (isOpen) {
        for (const b of menu.querySelectorAll('.menu-item')) {
            const r = b.getBoundingClientRect();
            if (r.width <= 0) continue;
            areas.push({
                kind: 'circle',
                cx: r.left + r.width / 2,
                cy: r.top + r.height / 2,
                r: r.width / 2 + HIT_MARGIN,
            });
        }
    }
    return areas;
}

// Bildirimi bir sonraki kareye erteler: `widgetAction('expand')` pencereyi ASENKRON
// büyütüyor, hemen ölçmek eski dikdörtgenleri gönderirdi.
let reportPending = false;
function reportHitAreas() {
    if (reportPending) return;
    reportPending = true;
    requestAnimationFrame(() => {
        reportPending = false;
        window.api.setHitAreas(collectHitAreas());
    });
}

// Eylem/zaman aşımı işleyicilerinin kullandığı ad — artık geometri bildirimi.
function updateMouseEvents() { reportHitAreas(); }
updateMouseEvents();

// Yerleşim değiştiğinde (pencere büyüdü/küçüldü) geometri de değişiyor.
window.addEventListener('resize', reportHitAreas);
// Yüzey üzerindeyken hareket, açılan/kapanan alt öğelerin geometrisini değiştirebiliyor.
document.addEventListener('mousemove', reportHitAreas, { passive: true });

// --- Tooltip ---
const tooltip = document.createElement('div');
tooltip.className = 'history-tooltip';
document.body.appendChild(tooltip);
let tooltipTimeout = null;

function showTooltip(text, rect) {
    clearTimeout(tooltipTimeout);
    tooltip.textContent = text;
    tooltip.style.left = `${rect.left}px`;
    const above = rect.top - 10 - 190;
    if (above > 0) {
        tooltip.style.top = `${rect.top - 10}px`;
        tooltip.style.transform = 'translateY(-100%)';
    } else {
        tooltip.style.top = `${rect.bottom + 10}px`;
        tooltip.style.transform = 'translateY(0)';
    }
    tooltip.classList.add('visible');
}

function hideTooltip() {
    clearTimeout(tooltipTimeout);
    tooltip.classList.remove('visible');
}

// --- Menu button tooltips ---
// The buttons carry aria-label rather than title on purpose: Chromium renders a native
// title tooltip in its own OS window at the normal window level, and this widget is
// pinned above that (screen-saver level), so the tooltip came up BEHIND the buttons.
// An in-page element lives inside the widget's own window and stays visible.
const btnTooltip = document.createElement('div');
btnTooltip.className = 'btn-tooltip';
document.body.appendChild(btnTooltip);
let btnTooltipTimeout = null;

function positionBtnTooltip(btn) {
    const rect = btn.getBoundingClientRect();
    const gap = 10, margin = 6;
    const w = btnTooltip.offsetWidth, h = btnTooltip.offsetHeight;

    // The button column hugs the widget's outer edge — there are only ~13px beyond it —
    // so the label points inward, and which way that is flips with the widget's side.
    const toRight = document.body.classList.contains('left-side');
    let left = toRight ? rect.right + gap : rect.left - gap - w;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));

    let top = rect.top + rect.height / 2 - h / 2;
    top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));

    btnTooltip.style.left = `${left}px`;
    btnTooltip.style.top = `${top}px`;
}

function showBtnTooltip(btn) {
    btnTooltip.textContent = btn.getAttribute('aria-label') || '';
    positionBtnTooltip(btn); // measurable while transparent, so it fades in already placed
    btnTooltip.classList.add('visible');
}

function hideBtnTooltip() {
    clearTimeout(btnTooltipTimeout);
    btnTooltip.classList.remove('visible');
}

document.querySelectorAll('.menu-item').forEach(btn => {
    btn.addEventListener('mouseenter', () => {
        clearTimeout(btnTooltipTimeout);
        btnTooltipTimeout = setTimeout(() => showBtnTooltip(btn), BTN_TOOLTIP_DELAY_MS);
    });
    btn.addEventListener('mouseleave', hideBtnTooltip);
    // The menu collapses on click; a lingering label would outlive the button.
    btn.addEventListener('click', hideBtnTooltip);
});

historyItemsContainer.addEventListener('scroll', hideTooltip, { passive: true });

// --- Virtual Scroll ---
// Must equal the fixed .history-item height in widget.css — the virtual list
// positions rows purely by arithmetic on this constant.
const ITEM_HEIGHT = 38;
const BUFFER = 4;

function renderVirtualList(items) {
    const containerHeight = historyItemsContainer.clientHeight || 340;
    const scrollTop = historyItemsContainer.scrollTop;

    const visibleStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
    const visibleEnd = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + BUFFER);
    const totalHeight = items.length * ITEM_HEIGHT;
    const offsetY = visibleStart * ITEM_HEIGHT;

    historyItemsContainer.innerHTML = '';

    if (offsetY > 0) {
        const spacer = document.createElement('div');
        spacer.style.height = `${offsetY}px`;
        historyItemsContainer.appendChild(spacer);
    }

    // Favorited-content lookup is rebuilt in renderHistory (on data change), not here
    const favoritedContents = favoritedContentsSet;

    for (let i = visibleStart; i < visibleEnd; i++) {
        const item = items[i];
        const isInFavoritesTab = activeTab === 'favorites';

        const div = document.createElement('div');
        div.className = 'history-item';

        // Leading glyph — or, for a colour, the colour itself. Same anatomy as the main
        // window's rows.
        const type = C.classify(item.content);
        const iconEl = document.createElement('span');
        iconEl.className = 'row-icon';
        const colour = type === 'color' ? C.cssColor(item.content) : null;
        if (colour) {
            const swatch = document.createElement('span');
            swatch.className = 'row-swatch';
            swatch.style.background = colour;
            iconEl.appendChild(swatch);
        } else {
            iconEl.innerHTML = C.iconFor(type);
        }
        div.appendChild(iconEl);

        const textEl = document.createElement('div');
        textEl.className = C.MONO_TYPES.has(type) ? 'history-item-text mono' : 'history-item-text';
        textEl.textContent = C.previewText(item.content, PREVIEW_CHARS);
        div.appendChild(textEl);

        // Trailing slot: the timestamp, replaced in place by the actions on hover.
        const trail = document.createElement('div');
        trail.className = 'row-trail';

        const metaEl = document.createElement('div');
        metaEl.className = 'history-item-meta';
        metaEl.textContent = formatMeta(item.timestamp);
        trail.appendChild(metaEl);

        // Row actions (favorite / copy / delete) — mirrors the main window's row
        const actions = document.createElement('div');
        actions.className = 'history-actions';

        const isFav = isInFavoritesTab || favoritedContents.has(item.content);
        const starBtn = document.createElement('button');
        starBtn.className = 'action-btn star-btn' + (isFav ? ' active' : '');
        starBtn.innerHTML = isFav ? ICONS.starFilled : ICONS.starOutline;
        starBtn.title = isInFavoritesTab ? t('Favorilerden Çıkar') : (isFav ? 'Zaten Favorilerde' : t('Favorilere Ekle'));
        starBtn.setAttribute('aria-label', starBtn.title);
        starBtn.onclick = (e) => {
            e.stopPropagation();
            hideTooltip();
            if (isInFavoritesTab) {
                window.api.removeFromFavorites(item.id);
                allFavoriteItems = allFavoriteItems.filter(f => f.id !== item.id);
                renderHistory(allHistoryItems, allFavoriteItems);
            } else if (!favoritedContents.has(item.content)) {
                // Add and let the main-process broadcast refresh the list with the REAL id.
                // (Previously inserted a fake '_local_'+Date.now() id that couldn't be removed
                // and desynced the widget from the store.)
                window.api.addToFavorites({ content: item.content, timestamp: item.timestamp });
            }
        };

        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn';
        copyBtn.innerHTML = ICONS.copy;
        copyBtn.title = t('Kopyala');
        copyBtn.setAttribute('aria-label', t('Kopyala'));
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            window.api.copyItem(item.content);
            closeAll();
        };

        actions.appendChild(starBtn);
        actions.appendChild(copyBtn);

        // Only the history tab gets a delete button. In favourites the star above it
        // already IS the removal control — the two were wired to the same call, so the
        // row carried the same action twice.
        if (!isInFavoritesTab) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'action-btn del';
            deleteBtn.innerHTML = ICONS.trash;
            deleteBtn.title = t('Sil');
            deleteBtn.setAttribute('aria-label', deleteBtn.title);
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                hideTooltip();
                window.api.deleteHistoryItem(item.id);
                allHistoryItems = allHistoryItems.filter(h => h.id !== item.id);
                renderHistory(allHistoryItems, allFavoriteItems);
            };
            actions.appendChild(deleteBtn);
        }

        trail.appendChild(actions);
        div.appendChild(trail);

        div.addEventListener('click', () => {
            window.api.copyItem(item.content);
            closeAll();
        });

        div.addEventListener('mouseenter', () => {
            tooltipTimeout = setTimeout(() => {
                showTooltip(C.clip(item.content, TOOLTIP_CHARS), div.getBoundingClientRect());
            }, TOOLTIP_DELAY_MS);
        });
        div.addEventListener('mouseleave', () => {
            clearTimeout(tooltipTimeout);
            hideTooltip();
        });

        historyItemsContainer.appendChild(div);
    }

    const bottomHeight = totalHeight - offsetY - (visibleEnd - visibleStart) * ITEM_HEIGHT;
    if (bottomHeight > 0) {
        const spacer = document.createElement('div');
        spacer.style.height = `${bottomHeight}px`;
        historyItemsContainer.appendChild(spacer);
    }
}

function renderHistory(history, favorites) {
    allHistoryItems = history || [];
    allFavoriteItems = favorites || [];
    favoritedContentsSet = new Set(allFavoriteItems.map(f => f.content));

    let displayItems = activeTab === 'favorites' ? allFavoriteItems : allHistoryItems;

    // Apply Search Filter
    if (searchQuery) {
        // Folded, not lowercased: plain toLowerCase cannot match Turkish (see
        // CopyBoardShared.fold).
        const q = fold(searchQuery);
        displayItems = displayItems.filter(item => matchesSearch(item, q));
    }

    historyItemsContainer.scrollTop = 0;
    hideTooltip();

    // Cancel any pending scroll render from a previous list
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }

    if (displayItems.length === 0) {
        const msg = searchQuery ? t('Eşleşen sonuç bulunamadı') : (activeTab === 'favorites' ? t('Favori öğe yok') : t('Geçmiş boş'));
        // textContent, not an innerHTML string with an inline style: the message can
        // contain a search term, and the class carries the styling so the window needs no
        // 'unsafe-inline' in its CSP.
        historyItemsContainer.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = msg;
        historyItemsContainer.appendChild(empty);
        return;
    }

    historyItemsContainer.onscroll = () => {
        hideTooltip();
        // Throttle re-renders to one per animation frame to avoid scroll jank
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
            scrollRaf = null;
            renderVirtualList(displayItems);
        });
    };

    renderVirtualList(displayItems);
}

async function loadHistory() {
    const requestId = ++lastHistoryRequestId;
    const data = await window.api.getHistory();
    if (requestId === lastHistoryRequestId) {
        renderHistory(data.history || [], data.favorites || []);
    }
}

// --- Search ---
widgetSearch.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderHistory(allHistoryItems, allFavoriteItems);
});

// --- Tab Switching ---
tabHistory.addEventListener('click', () => {
    if (activeTab === 'history') return;
    activeTab = 'history';
    tabHistory.classList.add('active');
    tabFavorites.classList.remove('active');
    renderHistory(allHistoryItems, allFavoriteItems);
});

tabFavorites.addEventListener('click', () => {
    if (activeTab === 'favorites') return;
    activeTab = 'favorites';
    tabFavorites.classList.add('active');
    tabHistory.classList.remove('active');
    renderHistory(allHistoryItems, allFavoriteItems);
});

// --- Menu Toggle ---
mainBtn.addEventListener('click', (e) => {
    // Ignore clicks landing on the square corners outside the round button
    if (!isOverMainButton(e.clientX, e.clientY)) return;
    if (isDragging || (Date.now() - lastDragEndTime < 200)) return;
    if (collapseTimeout) { clearTimeout(collapseTimeout); collapseTimeout = null; }

    isOpen = !isOpen;
    if (isOpen) {
        menu.classList.add('open');
        mainBtn.classList.add('active');
        mainBtn.style.opacity = '1';
        window.api.widgetAction('expand');
        updateMouseEvents();
    } else {
        closeAll();
    }
});

function closeAll() {
    if (collapseTimeout) clearTimeout(collapseTimeout);
    if (historyTimeout) clearTimeout(historyTimeout);

    isOpen = false;
    isHistoryOpen = false;
    menu.classList.remove('open');
    mainBtn.classList.remove('active');
    historyPanel.classList.remove('open');
    hideTooltip();
    hideBtnTooltip();

    // Reset search
    searchQuery = '';
    widgetSearch.value = '';

    if (!mainBtn.matches(':hover')) {
        mainBtn.style.opacity = currentOpacity.toString();
    }

    collapseTimeout = setTimeout(() => {
        window.api.widgetAction('collapse');
        collapseTimeout = null;
        updateMouseEvents();
    }, 300);
}

// --- Drag ---
mainBtn.addEventListener('pointerdown', (e) => {
    isPointerDown = true;
    isDragging = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;

    let dragAnimFrame = null;
    let accumulatedDeltaX = 0;
    let accumulatedDeltaY = 0;

    // Capture pointer so we don't lose drag if mouse moves out of window
    mainBtn.setPointerCapture(e.pointerId);

    const onPointerMove = (moveEvent) => {
        lastMouseX = moveEvent.clientX; lastMouseY = moveEvent.clientY; haveMousePos = true;
        const deltaX = moveEvent.screenX - dragStartX;
        const deltaY = moveEvent.screenY - dragStartY;
        if (!isDragging && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) isDragging = true;

        if (isDragging) {
            accumulatedDeltaX += deltaX;
            accumulatedDeltaY += deltaY;
            dragStartX = moveEvent.screenX;
            dragStartY = moveEvent.screenY;

            if (!dragAnimFrame) {
                dragAnimFrame = requestAnimationFrame(() => {
                    if (accumulatedDeltaX !== 0 || accumulatedDeltaY !== 0) {
                        window.api.widgetAction('drag', { x: accumulatedDeltaX, y: accumulatedDeltaY });
                        accumulatedDeltaX = 0;
                        accumulatedDeltaY = 0;
                    }
                    dragAnimFrame = null;
                });
            }
        }
    };

    const onPointerUp = (upEvent) => {
        isPointerDown = false;
        mainBtn.releasePointerCapture(upEvent.pointerId);
        mainBtn.removeEventListener('pointermove', onPointerMove);
        mainBtn.removeEventListener('pointerup', onPointerUp);

        if (dragAnimFrame) {
            cancelAnimationFrame(dragAnimFrame);
            dragAnimFrame = null;
        }

        if (isDragging) {
            // Apply any remaining delta before ending drag
            if (accumulatedDeltaX !== 0 || accumulatedDeltaY !== 0) {
                window.api.widgetAction('drag', { x: accumulatedDeltaX, y: accumulatedDeltaY });
            }
            window.api.widgetAction('drag-end');
            lastDragEndTime = Date.now();
            isDragging = false;
            // IMPORTANT: Reset renderer state so the panel doesn't think it's still open
            closeAll();
        }
        updateMouseEvents();
    };

    mainBtn.addEventListener('pointermove', onPointerMove);
    mainBtn.addEventListener('pointerup', onPointerUp);
});

// --- Panel Toggle ---
btnSnippet.addEventListener('click', async () => {
    if (historyTimeout) { clearTimeout(historyTimeout); historyTimeout = null; }

    isHistoryOpen = !isHistoryOpen;
    if (isHistoryOpen) {
        mainBtn.style.opacity = '1';
        window.api.widgetAction('expand-history');
        await loadHistory();
        setTimeout(() => { if (isHistoryOpen) historyPanel.classList.add('open'); }, 10);
    } else {
        historyPanel.classList.remove('open');
        hideTooltip();
        historyTimeout = setTimeout(() => {
            if (!isHistoryOpen) {
                window.api.widgetAction('collapse-history');
                updateMouseEvents();
            }
            historyTimeout = null;
        }, 300);
    }
});

btnScreenshot.addEventListener('click', () => window.api.widgetAction('capture-draw'));
btnOcr.addEventListener('click', () => window.api.widgetAction('capture-ocr'));
btnVideo.addEventListener('click', () => window.api.widgetAction('capture-video'));
btnScroll.addEventListener('click', () => window.api.widgetAction('capture-scroll'));
btnOpenMain.addEventListener('click', () => {
    window.api.widgetAction('open-list');
    closeAll();
});

window.addEventListener('blur', () => { if (isOpen) closeAll(); });

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (isOpen || isHistoryOpen) {
            closeAll();
        }
    }
});

window.api.onUpdateHistory((data) => {
    if (isHistoryOpen) {
        renderHistory(data.history || [], data.favorites || []);
    }
});

// Apply/remove left-side class based on which edge widget is snapped to
window.api.onWidgetSide((side) => {
    if (side === 'left') {
        document.body.classList.add('left-side');
    } else {
        document.body.classList.remove('left-side');
    }
});

// isUp (true/false) değerine göre sınıf ekle
window.api.onWidgetDirection((isUp) => {
    if (isUp) {
        document.body.classList.add('up-side');
    } else {
        document.body.classList.remove('up-side');
    }
});

// Update widget appearance
window.api.onWidgetConfig((config) => {
    if (config.color) {
        document.documentElement.style.setProperty('--primary', config.color);
    }

    const mainBtn = document.getElementById('widget-main');
    const mainIcon = mainBtn.querySelector('svg');

    // Opacity formatting
    const opacityValue = config.opacity !== undefined ? config.opacity : 100;
    currentOpacity = opacityValue / 100;

    // Remove buggy container-wide opacity
    document.getElementById('widget-container').style.opacity = '';

    // Set immediate opacity on the main button if it's inactive
    if (!isOpen && !isHistoryOpen && !mainBtn.matches(':hover')) {
        mainBtn.style.opacity = currentOpacity.toString();
    } else {
        mainBtn.style.opacity = '1';
    }

    if (config.transparent) {
        mainBtn.style.background = 'transparent';
        mainBtn.style.boxShadow = 'none';
        mainBtn.style.backdropFilter = 'none';
        mainBtn.style.webkitBackdropFilter = 'none';
        mainIcon.style.color = config.color || 'var(--primary)';
        // Set the border color to match the selected icon color
        mainBtn.style.borderColor = config.color || 'var(--primary)';
    } else {
        mainBtn.style.background = '';
        mainBtn.style.boxShadow = '';
        mainBtn.style.backdropFilter = '';
        mainBtn.style.webkitBackdropFilter = '';
        mainIcon.style.color = '';
        mainBtn.style.borderColor = '';
    }
});
