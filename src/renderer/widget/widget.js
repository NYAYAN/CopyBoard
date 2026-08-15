const mainBtn = document.getElementById('widget-main');
const menu = document.getElementById('widget-menu');
const btnSnippet = document.getElementById('btn-snippet');
const btnQuickPaste = document.getElementById('btn-quickpaste');
const btnScreenshot = document.getElementById('btn-screenshot');
const btnOcr = document.getElementById('btn-ocr');
const btnVideo = document.getElementById('btn-video');
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
const { ICONS, matchesSearch } = window.CopyBoardShared;

// DISPLAY-only caps: rows and the hover tooltip clip what goes into the DOM — a copied
// item can be hundreds of KB. Copy/search always use the full in-memory item.content.
// Rows are single-line ellipsized, so ~300 chars covers any width.
const PREVIEW_CHARS = 300;
const TOOLTIP_CHARS = 500;
const TOOLTIP_DELAY_MS = 500;
// Shorter than the history-row delay: these are icon-only buttons, so the label is the
// only way to tell them apart and waiting half a second to find out is too slow.
const BTN_TOOLTIP_DELAY_MS = 300;
const clip = (s, max) => (s && s.length > max ? s.slice(0, max) + '…' : s);

// Same date/time presentation as the main-window list, so the two designs match.
// Cached formatters — constructing Intl.DateTimeFormat per row per render is costly.
const DATE_FMT = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const formatMeta = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return isNaN(d) ? '' : `${DATE_FMT.format(d)} ${TIME_FMT.format(d)}`;
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

// True only over an actually-visible widget surface: the round main button (always),
// the round menu items (when the menu is open), or the history panel rect (when open).
// Everything else — the wide transparent panel-gap left of the buttons AND the gaps
// between icons — forwards clicks to the app underneath.
function isOverInteractive(x, y) {
    if (isHistoryOpen) {
        const p = historyPanel.getBoundingClientRect();
        if (x >= p.left && x <= p.right && y >= p.top && y <= p.bottom) return true;
    }
    if (isOverMainButton(x, y)) return true;
    if (isOpen) {
        for (const b of menu.querySelectorAll('.menu-item')) {
            const r = b.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const radius = r.width / 2 + HIT_MARGIN;
            const dx = x - cx;
            const dy = y - cy;
            if (dx * dx + dy * dy <= radius * radius) return true;
        }
    }
    return false;
}

// --- setIgnoreMouseEvents (only fire IPC when the state actually changes) ---
let lastIgnoreState = null;
function setIgnore(ignore, options) {
    if (lastIgnoreState === ignore) return;
    lastIgnoreState = ignore;
    // The cursor just landed on a widget surface, so we are still NOT the frontmost
    // app — this is the last moment we can see which app the user is typing in. The
    // click that follows makes CopyBoard frontmost, and a Quick-Paste pick has to be
    // handed back to that app. macOS-only; a no-op elsewhere.
    if (!ignore) window.api.widgetAction('note-front-app');
    window.api.setIgnoreMouseEvents(ignore, options);
}

// Last known cursor position (client coords). Lets refreshIgnore() re-evaluate the
// capture/forward decision after a state change (open/close) even when the mouse has
// NOT moved — otherwise closing the menu with a stationary cursor over the button
// would leave the window in forward mode and the button unclickable until a mousemove.
let lastMouseX = 0, lastMouseY = 0, haveMousePos = false;

function refreshIgnore() {
    // During an active drag/press keep capturing so the gesture isn't lost.
    if (isDragging || isPointerDown) {
        setIgnore(false);
        return;
    }
    // Capture only when the cursor is over a real widget surface (round buttons /
    // open panel); forward everywhere else so the app underneath stays clickable —
    // including the empty panel-area beside the buttons when the menu is open.
    if (haveMousePos && isOverInteractive(lastMouseX, lastMouseY)) {
        setIgnore(false);
    } else {
        setIgnore(true, { forward: true });
    }
}

// Public name used by the action/timeout handlers; now position-aware (re-uses the
// last cursor position) so transitions with a stationary cursor are handled correctly.
function updateMouseEvents() { refreshIgnore(); }
updateMouseEvents();

// Use mousemove (not mouseenter/leave) so setIgnoreMouseEvents(true,{forward})
// forwarded events still trigger detection even when the mouse was already over a button.
document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    haveMousePos = true;
    refreshIgnore();
}, { passive: true });

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
const ITEM_HEIGHT = 44;
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

        const textEl = document.createElement('div');
        textEl.className = 'history-item-text';
        textEl.textContent = clip(item.content, PREVIEW_CHARS);
        div.appendChild(textEl);

        // Timestamp inline at the right — mirrors the main-window row design
        const metaEl = document.createElement('div');
        metaEl.className = 'history-item-meta';
        metaEl.textContent = formatMeta(item.timestamp);
        div.appendChild(metaEl);

        // Row actions (favorite / copy / delete) — mirrors the main window's row
        const actions = document.createElement('div');
        actions.className = 'history-actions';

        const isFav = isInFavoritesTab || favoritedContents.has(item.content);
        const starBtn = document.createElement('button');
        starBtn.className = 'action-btn star-btn' + (isFav ? ' active' : '');
        starBtn.innerHTML = isFav ? ICONS.starFilled : ICONS.starOutline;
        starBtn.title = isInFavoritesTab ? 'Favorilerden Çıkar' : (isFav ? 'Zaten Favorilerde' : 'Favorilere Ekle');
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
        copyBtn.title = 'Kopyala';
        copyBtn.setAttribute('aria-label', 'Kopyala');
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            window.api.copyItem(item.content);
            closeAll();
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn del';
        deleteBtn.innerHTML = ICONS.trash;
        deleteBtn.title = isInFavoritesTab ? 'Favorilerden Çıkar' : 'Sil';
        deleteBtn.setAttribute('aria-label', deleteBtn.title);
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            hideTooltip();
            if (isInFavoritesTab) {
                window.api.removeFromFavorites(item.id);
                allFavoriteItems = allFavoriteItems.filter(f => f.id !== item.id);
            } else {
                window.api.deleteHistoryItem(item.id);
                allHistoryItems = allHistoryItems.filter(h => h.id !== item.id);
            }
            renderHistory(allHistoryItems, allFavoriteItems);
        };

        actions.appendChild(starBtn);
        actions.appendChild(copyBtn);
        actions.appendChild(deleteBtn);
        div.appendChild(actions);

        div.addEventListener('click', () => {
            window.api.copyItem(item.content);
            closeAll();
        });

        div.addEventListener('mouseenter', () => {
            tooltipTimeout = setTimeout(() => {
                showTooltip(clip(item.content, TOOLTIP_CHARS), div.getBoundingClientRect());
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
        const q = searchQuery.toLowerCase();
        displayItems = displayItems.filter(item => matchesSearch(item, q));
    }

    historyItemsContainer.scrollTop = 0;
    hideTooltip();

    // Cancel any pending scroll render from a previous list
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }

    if (displayItems.length === 0) {
        const msg = searchQuery ? 'Eşleşen sonuç bulunamadı' : (activeTab === 'favorites' ? 'Favori öğe yok' : 'Geçmiş boş');
        historyItemsContainer.innerHTML = `<div style="padding: 20px; text-align: center; opacity: 0.5; font-size: 13px;">${msg}</div>`;
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
        setIgnore(false);
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

// Mouse-driven Quick Paste. This is the ONLY way in when macOS Secure Event Input is
// active (any focused password field): the OS then hands keystrokes exclusively to that
// app, so our global accelerator never fires — but mouse events are untouched.
btnQuickPaste.addEventListener('click', () => {
    window.api.widgetAction('quickpaste');
    closeAll();
});

btnScreenshot.addEventListener('click', () => window.api.widgetAction('capture-draw'));
btnOcr.addEventListener('click', () => window.api.widgetAction('capture-ocr'));
btnVideo.addEventListener('click', () => window.api.widgetAction('capture-video'));
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
