const mainBtn = document.getElementById('widget-main');
const menu = document.getElementById('widget-menu');
const btnSnippet = document.getElementById('btn-snippet');
const btnScreenshot = document.getElementById('btn-screenshot');
const btnOcr = document.getElementById('btn-ocr');
const btnVideo = document.getElementById('btn-video');
const historyPanel = document.getElementById('history-panel');
const historyItemsContainer = document.getElementById('history-items');
const tabHistory = document.getElementById('tab-history');
const tabFavorites = document.getElementById('tab-favorites');

let isOpen = false;
let isHistoryOpen = false;
let isDragging = false;
let dragStartX, dragStartY;
let collapseTimeout = null;
let historyTimeout = null;
let lastHistoryRequestId = 0;
let activeTab = 'history'; // 'history' | 'favorites'
let allHistoryItems = [];
let allFavoriteItems = [];

// --- setIgnoreMouseEvents ---
function updateMouseEvents() {
    if (isOpen || isHistoryOpen) {
        window.api.setIgnoreMouseEvents(false);
    } else {
        window.api.setIgnoreMouseEvents(true, { forward: true });
    }
}
updateMouseEvents();

// Use mousemove (not mouseenter/leave) so setIgnoreMouseEvents(true,{forward})
// forwarded events still trigger detection even when mouse was already over button.
const widgetContainer = document.querySelector('.widget-container');
document.addEventListener('mousemove', (e) => {
    if (isOpen || isHistoryOpen) {
        window.api.setIgnoreMouseEvents(false);
        return;
    }
    const rect = widgetContainer.getBoundingClientRect();
    const over = e.clientX >= rect.left && e.clientX <= rect.right
        && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (over) {
        window.api.setIgnoreMouseEvents(false);
    } else {
        window.api.setIgnoreMouseEvents(true, { forward: true });
    }
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

historyItemsContainer.addEventListener('scroll', hideTooltip, { passive: true });

// --- Virtual Scroll ---
const ITEM_HEIGHT = 56;
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

    // Build set of favorited content for quick lookup
    const favoritedContents = new Set(allFavoriteItems.map(f => f.content));

    for (let i = visibleStart; i < visibleEnd; i++) {
        const item = items[i];
        const isInFavoritesTab = activeTab === 'favorites';

        const div = document.createElement('div');
        div.className = 'history-item';

        const textEl = document.createElement('div');
        textEl.className = 'history-item-text';
        textEl.textContent = item.content;
        div.appendChild(textEl);

        // Star button: add to/remove from favorites
        const starBtn = document.createElement('button');
        starBtn.className = 'delete-btn'; // reuse style but repurpose
        starBtn.style.cssText = 'font-size:13px; background:transparent; border:none; right:30px;';
        if (isInFavoritesTab) {
            starBtn.textContent = '⭐';
            starBtn.title = 'Favorilerden Çıkar';
            starBtn.onclick = (e) => {
                e.stopPropagation();
                hideTooltip();
                window.api.removeFromFavorites(item.id);
                allFavoriteItems = allFavoriteItems.filter(f => f.id !== item.id);
                renderHistory(allHistoryItems, allFavoriteItems);
            };
        } else {
            const isFav = favoritedContents.has(item.content);
            starBtn.textContent = isFav ? '⭐' : '☆';
            starBtn.title = isFav ? 'Zaten Favorilerde' : 'Favorilere Ekle';
            starBtn.onclick = (e) => {
                e.stopPropagation();
                if (!isFav) {
                    window.api.addToFavorites({ content: item.content, timestamp: item.timestamp });
                    allFavoriteItems.unshift({ id: '_local_' + Date.now(), content: item.content, timestamp: item.timestamp });
                    renderHistory(allHistoryItems, allFavoriteItems);
                }
            };
        }
        div.appendChild(starBtn);

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = '×';
        deleteBtn.title = isInFavoritesTab ? 'Favorilerden Çıkar' : 'Sil';
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
        div.appendChild(deleteBtn);

        div.addEventListener('click', () => {
            window.api.copyItem(item.content);
            closeAll();
        });

        div.addEventListener('mouseenter', () => {
            tooltipTimeout = setTimeout(() => {
                showTooltip(item.content, div.getBoundingClientRect());
            }, 400);
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

    const displayItems = activeTab === 'favorites' ? allFavoriteItems : allHistoryItems;

    historyItemsContainer.scrollTop = 0;
    hideTooltip();

    if (displayItems.length === 0) {
        const msg = activeTab === 'favorites' ? 'Favori öğe yok' : 'Geçmiş boş';
        historyItemsContainer.innerHTML = `<div style="padding: 20px; text-align: center; opacity: 0.5; font-size: 13px;">${msg}</div>`;
        return;
    }

    historyItemsContainer.onscroll = () => {
        hideTooltip();
        renderVirtualList(displayItems);
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
mainBtn.addEventListener('click', () => {
    if (isDragging) return;
    if (collapseTimeout) { clearTimeout(collapseTimeout); collapseTimeout = null; }

    isOpen = !isOpen;
    if (isOpen) {
        menu.classList.add('open');
        mainBtn.classList.add('active');
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

    collapseTimeout = setTimeout(() => {
        window.api.widgetAction('collapse');
        collapseTimeout = null;
        updateMouseEvents();
    }, 300);
}

// --- Drag ---
mainBtn.addEventListener('mousedown', (e) => {
    isDragging = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;

    const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.screenX - dragStartX;
        const deltaY = moveEvent.screenY - dragStartY;
        if (!isDragging && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) isDragging = true;
        if (isDragging) {
            window.api.widgetAction('drag', { x: deltaX, y: deltaY });
            dragStartX = moveEvent.screenX;
            dragStartY = moveEvent.screenY;
        }
    };

    const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (isDragging) window.api.widgetAction('drag-end');
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

// --- Panel Toggle ---
btnSnippet.addEventListener('click', async () => {
    if (historyTimeout) { clearTimeout(historyTimeout); historyTimeout = null; }

    isHistoryOpen = !isHistoryOpen;
    if (isHistoryOpen) {
        window.api.setIgnoreMouseEvents(false);
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

window.addEventListener('blur', () => { if (isOpen) closeAll(); });

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
