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
    elements.aboutPanel.classList.add('hidden');
    elements.settingsBtn.classList.remove('active');
    elements.aboutBtn.classList.remove('active');

    hideModal(elements.addItemModal);
    hideModal(elements.noteModal);
    hideModal(elements.confirmModal);
}
