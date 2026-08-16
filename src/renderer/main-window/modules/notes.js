import { elements } from './dom.js';
import { showModal, hideModal } from './modals.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

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
    elements.noteModalTitle.textContent = t('Not');
    elements.noteViewContent.textContent = text;
    elements.noteInput.value = text;

    elements.noteViewContent.classList.remove('hidden');
    elements.noteInput.classList.add('hidden');
    elements.noteViewActions.classList.remove('hidden');
    elements.noteEditActions.classList.add('hidden');
    elements.copyNoteBtn.classList.remove('hidden'); // there is a note to copy
}

export function showNoteEditMode(text) {
    elements.noteModalTitle.textContent = text ? t('Notu Düzenle') : t('Not Ekle');
    elements.noteInput.value = text;

    elements.noteViewContent.classList.add('hidden');
    elements.noteInput.classList.remove('hidden');
    elements.noteViewActions.classList.add('hidden');
    elements.noteEditActions.classList.remove('hidden');
    elements.copyNoteBtn.classList.add('hidden'); // nothing settled to copy while editing

    elements.noteInput.focus();
}

export function closeNoteModal() {
    hideModal(elements.noteModal);
    currentNoteItemId = null;
}
