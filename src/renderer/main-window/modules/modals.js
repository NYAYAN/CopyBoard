import { elements } from './dom.js';

export function showModal(modal) {
    modal.classList.remove('hidden');
}

export function hideModal(modal) {
    modal.classList.add('hidden');
}

export function resetView() {
    // Close panels
    elements.settingsPanel.classList.add('hidden');
    elements.galleryPanel.classList.add('hidden');
    elements.settingsBtn.classList.remove('active');
    elements.galleryBtn.classList.remove('active');
    // Back to the list, so that's the button that lights up.
    elements.historyBtn.classList.add('active');

    hideModal(elements.noteModal);
    hideModal(elements.confirmModal);
}
