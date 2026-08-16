import { elements } from './dom.js';

export function showModal(modal) {
    modal.classList.remove('hidden');
}

export function hideModal(modal) {
    modal.classList.add('hidden');
}

// One confirm dialog, asked for by whoever needs it, resolving to true/false.
//
// It exists because some of these actions cannot be taken back: clearing history, and —
// the reason it grew past a single hard-coded dialog — removing a favourite. A favourite
// carries a note and a hand-chosen position in the list, and neither survives re-starring
// the same text later. A keystroke should not be able to spend that silently.
let resolver = null;

export function confirmAction({ title, text, confirmLabel }) {
    elements.confirmTitle.textContent = title;
    elements.confirmText.textContent = text;
    elements.confirmOk.textContent = confirmLabel;
    showModal(elements.confirmModal);
    // Focus the confirm button so Enter accepts and Escape cancels without a mouse. It is
    // the destructive one, but the dialog only exists because the user already asked for
    // the action — the second keystroke is the deliberate part.
    requestAnimationFrame(() => elements.confirmOk.focus());

    // A second request while one is open would strand the first promise; answer it "no".
    if (resolver) resolver(false);
    return new Promise((resolve) => { resolver = resolve; });
}

// Close the dialog and hand the answer back. Every exit route goes through here —
// including Escape — or the awaiting promise would hang forever.
export function settleConfirm(answer) {
    hideModal(elements.confirmModal);
    const resolve = resolver;
    resolver = null;
    if (resolve) resolve(answer);
}

// The window was re-shown: close whatever was open and land back on the list. Views are
// mutually exclusive and named by data-view, so "close every panel" is one assignment.
export function resetView() {
    elements.app.dataset.view = 'history';
    hideModal(elements.noteModal);
    settleConfirm(false);
}
