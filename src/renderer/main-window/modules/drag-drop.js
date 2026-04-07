import { elements } from './dom.js';

let dragStartIndex;

export function onDragStart(e) {
    if (this.dataset.tabContext !== 'favorites') return; // Additional safety
    dragStartIndex = +this.getAttribute('data-list-index');
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

    const dragEndIndex = +this.getAttribute('data-list-index');
    this.classList.remove('dragging');

    if (dragStartIndex !== undefined && dragStartIndex !== dragEndIndex) {
        moveFavorite(dragStartIndex, dragEndIndex, favorites);
    }
}

function moveFavorite(fromIndex, toIndex, favorites) {
    // Correctly move the item in the array
    const [movedItem] = favorites.splice(fromIndex, 1);
    favorites.splice(toIndex, 0, movedItem);

    // Use the dedicated favorites reorder IPC
    window.api.reorderFavorites(favorites);
}
