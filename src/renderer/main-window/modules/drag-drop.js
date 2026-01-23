import { elements } from './dom.js';
import { renderHistory } from './history-renderer.js';

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

export function onDrop(e, currentHistory, activeTab) {
    e.stopPropagation();
    // Context check passed via binding or caller
    if (activeTab !== 'favorites') return;

    const dragEndIndex = +this.getAttribute('data-list-index');
    const item = this;

    if (dragStartIndex !== dragEndIndex) {
        swapFavorites(dragStartIndex, dragEndIndex, currentHistory);
        item.classList.remove('dragging');
    }
}

function swapFavorites(fromIndex, toIndex, currentHistory) {
    const favorites = currentHistory.filter(i => i.isFavorite);
    const itemA = favorites[fromIndex];
    const itemB = favorites[toIndex];
    const realIndexA = currentHistory.findIndex(i => i.id === itemA.id);
    const realIndexB = currentHistory.findIndex(i => i.id === itemB.id);

    const temp = currentHistory[realIndexA];
    currentHistory[realIndexA] = currentHistory[realIndexB];
    currentHistory[realIndexB] = temp;

    window.api.reorderHistory(currentHistory);
    renderHistory(currentHistory, 'favorites'); // Re-render immediately
}
