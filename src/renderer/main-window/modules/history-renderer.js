import { elements } from './dom.js';
import { openNoteModal } from './notes.js';
import { onDragStart, onDragOver, onDrop } from './drag-drop.js';

export function renderHistory(history, favorites, activeTab, query = '') {
    elements.listElement.innerHTML = '';

    let items = activeTab === 'favorites' ? favorites : history;

    // Search Filter
    if (query) {
        const q = query.toLowerCase();
        items = items.filter(item => {
            const contentMatch = item.content && item.content.toLowerCase().includes(q);
            const noteMatch = item.note && item.note.toLowerCase().includes(q);
            return contentMatch || noteMatch;
        });
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

        const dateStr = itemDate.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = itemDate.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        const metaText = `${dateStr} ${timeStr}`;

        const domItem = document.createElement('div');
        domItem.className = 'history-item';
        domItem.setAttribute('data-list-index', index);
        domItem.title = itemContent;

        // Drag handles for favorites (reordering)
        if (activeTab === 'favorites') {
            domItem.classList.add('favorites-tab');
            domItem.dataset.tabContext = 'favorites';
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
        textSpan.textContent = itemContent;

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
            infoBtn.innerHTML = item.note ? '📝' : 'ℹ️';
            infoBtn.title = item.note ? 'Notu Düzenle' : 'Not Ekle';
            if (item.note) infoBtn.title += `\nNot: ${item.note.substring(0, 50)}${item.note.length > 50 ? '...' : ''}`;
            infoBtn.addEventListener('click', (e) => { e.stopPropagation(); openNoteModal(item); });
            actionsDiv.appendChild(infoBtn);
        }

        // Star button
        const starBtn = document.createElement('button');
        if (activeTab === 'favorites') {
            // In Favoriler: always ⭐, clicking removes from favorites
            starBtn.className = 'action-btn star-btn active';
            starBtn.innerHTML = '⭐';
            starBtn.title = 'Favorilerden Çıkar';
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.api.removeFromFavorites(item.id);
            });
        } else {
            // In Tümü: show ⭐ if already favorited (by content), ☆ if not
            const isAlreadyFavorited = favoritedContents.has(itemContent);
            starBtn.className = `action-btn star-btn ${isAlreadyFavorited ? 'active' : ''}`;
            starBtn.innerHTML = isAlreadyFavorited ? '⭐' : '☆';
            starBtn.title = isAlreadyFavorited ? 'Favorilere Zaten Eklendi' : 'Favorilere Ekle';
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
        deleteBtn.title = activeTab === 'favorites' ? 'Favorilerden Çıkar' : 'Sil';
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
