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

    // State reset (if needed, handled by main logic)
}

export function showToast(message, type) {
    elements.toastElement.textContent = message;
    elements.toastElement.className = `toast visible ${type}`;
    // Clear previous if any (handled via simple timeout re-assignment usually, 
    // but here we just rely on CSS transitions mostly or simplified logic)
    // A more robust way:
    if (window.toastTimeout) clearTimeout(window.toastTimeout);
    window.toastTimeout = setTimeout(() => elements.toastElement.className = 'toast hidden', 3000);
}
