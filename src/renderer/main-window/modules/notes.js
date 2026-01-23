import { elements } from './dom.js';
import { showModal, hideModal } from './modals.js';

let currentNoteItemId = null;

export function getCurrentNoteItemId() {
    return currentNoteItemId;
}

export function setCurrentNoteItemId(id) {
    currentNoteItemId = id;
}

export function openNoteModal(item) {
    currentNoteItemId = item.id;
    showModal(elements.noteModal);

    if (item.note && item.note.trim().length > 0) {
        showNoteViewMode(item.note);
    } else {
        showNoteEditMode('');
    }
}

export function showNoteViewMode(text) {
    elements.noteModalTitle.textContent = 'Not';
    elements.noteViewContent.textContent = text;
    elements.noteInput.value = text;

    elements.noteViewContent.classList.remove('hidden');
    elements.noteInput.classList.add('hidden');
    elements.noteViewActions.classList.remove('hidden');
    elements.noteEditActions.classList.add('hidden');
}

export function showNoteEditMode(text) {
    elements.noteModalTitle.textContent = text ? 'Notu Düzenle' : 'Not Ekle';
    elements.noteInput.value = text;

    elements.noteViewContent.classList.add('hidden');
    elements.noteInput.classList.remove('hidden');
    elements.noteViewActions.classList.add('hidden');
    elements.noteEditActions.classList.remove('hidden');

    elements.noteInput.focus();
}

export function closeNoteModal() {
    hideModal(elements.noteModal);
    currentNoteItemId = null;
}
