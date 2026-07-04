import { elements } from './dom.js';

let dragStartId;

export function onDragStart(e) {
    if (this.dataset.tabContext !== 'favorites') return; // Additional safety
    // Reorder by item identity, not row index: the rendered rows can be a SEARCH-FILTERED
    // subset while `favorites` (passed to onDrop) is the full array, so positional indices
    // would move the wrong items and corrupt the persisted order.
    dragStartId = this.dataset.itemId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
    this.classList.add('dragging');
}

export function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

export function onDrop(e, favorites, activeTab) {
    e.stopPropagation();
    if (activeTab !== 'favorites') return;

    const dragEndId = this.dataset.itemId;
    this.classList.remove('dragging');

    if (dragStartId !== undefined && dragEndId !== undefined && dragStartId !== dragEndId) {
        moveFavorite(dragStartId, dragEndId, favorites);
    }
}

function moveFavorite(fromId, toId, favorites) {
    const fromIndex = favorites.findIndex(f => f.id === fromId);
    const toIndex = favorites.findIndex(f => f.id === toId);
    if (fromIndex === -1 || toIndex === -1) return;

    // Move the dragged item to the drop target's position in the full favorites array.
    const [movedItem] = favorites.splice(fromIndex, 1);
    favorites.splice(toIndex, 0, movedItem);

    // Use the dedicated favorites reorder IPC
    window.api.reorderFavorites(favorites);
}
