import { elements } from './dom.js';
import { openNoteModal } from './notes.js';
import { onDragStart, onDragOver, onDrop } from './drag-drop.js';

// Global state reference passed or imported? 
// Ideally passed params for purity, but we need to re-render.
// Let's export a render function that takes history and activeTab.

export function getFilteredHistory(history, activeTab) {
    if (activeTab === 'favorites') {
        return history.filter(i => i.isFavorite);
    }
    return history.filter(i => !i.hiddenFromHistory);
}

export function renderHistory(history, activeTab) {
    elements.listElement.innerHTML = '';

    // We can store currentHistory in a module scope if needed for DragDrop 
    // or pass it down. DragDrop needs the FULL history to swap real indices.
    // Let's assume we pass it to the drop handler.

    const filtered = getFilteredHistory(history, activeTab);

    if (filtered.length === 0) {
        elements.listElement.innerHTML = '<div class="empty-state">Liste boş.</div>';
        return;
    }

    filtered.forEach((item, index) => {
        const itemContent = item.content;
        const itemDate = item.timestamp ? new Date(item.timestamp) : new Date();

        const dateStr = itemDate.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = itemDate.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        const metaText = `${dateStr} ${timeStr}`;

        const domItem = document.createElement('div');
        domItem.className = 'history-item';
        domItem.setAttribute('data-list-index', index);
        domItem.title = itemContent;

        if (activeTab === 'favorites') {
            domItem.classList.add('favorites-tab');
            domItem.dataset.tabContext = 'favorites';
            domItem.setAttribute('draggable', 'true');
            domItem.addEventListener('dragstart', onDragStart);
            domItem.addEventListener('dragover', onDragOver);
            // We wrap onDrop to pass history context
            domItem.addEventListener('drop', function (e) { onDrop.call(this, e, history, activeTab); });
            domItem.addEventListener('dragend', () => domItem.classList.remove('dragging'));
        }

        if (activeTab === 'favorites') {
            const dragHandle = document.createElement('span');
            dragHandle.className = 'drag-handle';
            dragHandle.innerHTML = '⋮⋮';
            domItem.appendChild(dragHandle);
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'history-content';

        const textSpan = document.createElement('span');
        textSpan.className = 'history-text';
        textSpan.textContent = itemContent;

        const metaSpan = document.createElement('small');
        metaSpan.className = 'history-meta';
        metaSpan.textContent = metaText;

        contentDiv.appendChild(textSpan);
        contentDiv.appendChild(metaSpan);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'history-actions';

        if (activeTab === 'favorites') {
            const infoBtn = document.createElement('button');
            infoBtn.className = `action-btn info-btn ${item.note ? 'has-note' : ''}`;
            infoBtn.innerHTML = item.note ? '📝' : 'ℹ️';
            infoBtn.title = item.note ? 'Notu Düzenle' : 'Not Ekle';
            if (item.note) infoBtn.title += `\nNot: ${item.note.substring(0, 50)}${item.note.length > 50 ? '...' : ''}`;

            infoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openNoteModal(item);
            });
            actionsDiv.appendChild(infoBtn);
        }

        const starBtn = document.createElement('button');
        starBtn.className = `action-btn star-btn ${item.isFavorite ? 'active' : ''}`;
        starBtn.innerHTML = item.isFavorite ? '⭐' : '☆';
        starBtn.title = item.isFavorite ? 'Favorilerden Çıkar' : 'Favorilere Ekle';
        starBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.api.toggleFavorite(item.id);
        });

        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn copy-btn';
        copyBtn.innerHTML = '📋';
        copyBtn.title = 'Kopyala';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyBtn.innerHTML = '✅';
            setTimeout(() => { copyBtn.innerHTML = '📋'; }, 800);
            window.api.copyItem(itemContent);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn delete-btn';
        deleteBtn.innerHTML = '✕';
        deleteBtn.title = 'Sil';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.api.deleteHistoryItem(item.id, activeTab);
        });

        actionsDiv.appendChild(starBtn);
        actionsDiv.appendChild(copyBtn);
        actionsDiv.appendChild(deleteBtn);

        domItem.appendChild(contentDiv);
        domItem.appendChild(actionsDiv);

        domItem.addEventListener('click', (e) => {
            if (e.target.closest('.action-btn')) return;
            domItem.classList.add('copied');
            copyBtn.innerHTML = '✅';
            setTimeout(() => {
                domItem.classList.remove('copied');
                copyBtn.innerHTML = '📋';
            }, 800);
            window.api.copyItem(itemContent);
        });

        elements.listElement.appendChild(domItem);
    });
}
