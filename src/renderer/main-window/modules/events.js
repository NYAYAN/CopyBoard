import { elements } from './dom.js';
import { showModal, hideModal, resetView } from './modals.js';
import { renderHistory } from './history-renderer.js';
import {
    openNoteModal,
    closeNoteModal,
    showNoteEditMode,
    showNoteViewMode,
    getCurrentNoteItemId
} from './notes.js';

// State references
let state = {
    history: [],
    activeTab: 'all'
};

export function initState(initialHistory) {
    state.history = initialHistory;
}

export function updateHistoryState(newHistory) {
    state.history = newHistory;
    renderHistory(state.history, state.activeTab);
}

export function setupEventListeners() {

    // Tabs
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (state.activeTab === btn.dataset.tab) return;

            elements.listElement.classList.add('tab-switching');
            setTimeout(() => {
                elements.tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.activeTab = btn.dataset.tab;
                renderHistory(state.history, state.activeTab);

                setTimeout(() => {
                    elements.listElement.classList.remove('tab-switching');
                }, 50);
            }, 150);
        });
    });

    // Window Controls
    elements.minimizeBtn.addEventListener('click', () => window.api.closeWindow());
    window.addEventListener('focus', () => { if (document.activeElement) document.activeElement.blur(); });

    // Modals
    elements.addManualBtn.addEventListener('click', () => {
        showModal(elements.addItemModal);
        elements.manualTextInput.value = '';
        elements.manualTextInput.focus();
    });
    elements.cancelAddBtn.addEventListener('click', () => hideModal(elements.addItemModal));
    elements.confirmAddBtn.addEventListener('click', () => {
        const text = elements.manualTextInput.value.trim();
        if (text) {
            window.api.addManualItem(text);
            hideModal(elements.addItemModal);
        }
    });

    // Note Modal
    elements.closeNoteBtn.addEventListener('click', closeNoteModal);
    elements.editNoteBtn.addEventListener('click', () => showNoteEditMode(elements.noteInput.value));
    elements.cancelNoteBtn.addEventListener('click', () => {
        const item = state.history.find(i => i.id === getCurrentNoteItemId());
        if (item && item.note) {
            showNoteViewMode(item.note);
        } else {
            closeNoteModal();
        }
    });
    elements.saveNoteBtn.addEventListener('click', () => {
        const id = getCurrentNoteItemId();
        if (id) {
            const note = elements.noteInput.value.trim();
            window.api.setItemNote(id, note);
            closeNoteModal();
        }
    });

    // Settings / About
    elements.settingsBtn.addEventListener('click', () => {
        elements.aboutPanel.classList.add('hidden');
        elements.aboutBtn.classList.remove('active');
        elements.settingsPanel.classList.toggle('hidden');
        elements.settingsBtn.classList.toggle('active');
    });

    elements.aboutBtn.addEventListener('click', () => {
        elements.settingsPanel.classList.add('hidden');
        elements.settingsBtn.classList.remove('active');
        elements.aboutPanel.classList.toggle('hidden');
        elements.aboutBtn.classList.toggle('active');
    });

    // Inputs
    elements.autostartCheck.addEventListener('change', (e) => window.api.setAutoStart(e.target.checked));
    elements.maxItemsInput.addEventListener('change', (e) => {
        const value = parseInt(e.target.value);
        if (value > 0) window.api.setMaxItems(value);
    });
    elements.videoQualitySelect.addEventListener('change', (e) => window.api.setVideoQuality(e.target.value));

    // Shortcut Inputs
    setupShortcutInput(elements.shortcutInput, (s) => window.api.setShortcut(s));
    setupShortcutInput(elements.imageShortcutInput, (s) => window.api.setImageShortcut(s));
    setupShortcutInput(elements.ocrShortcutInput, (s) => window.api.setOcrShortcut(s));
    setupShortcutInput(elements.videoShortcutInput, (s) => window.api.setVideoShortcut(s));

    // Clear History
    elements.clearBtn.addEventListener('click', () => showModal(elements.confirmModal));
    elements.cancelClearBtn.addEventListener('click', () => hideModal(elements.confirmModal));
    elements.confirmClearBtn.addEventListener('click', () => {
        window.api.clearHistory();
        hideModal(elements.confirmModal);
    });

    // Global Keys
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') window.api.closeWindow();
        if (e.altKey && e.key.toLowerCase() === 'u') {
            console.log('Manual update check');
            window.api.checkForUpdates();
        }
    });
}

function setupShortcutInput(element, callback) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    element.addEventListener('keydown', (e) => {
        e.preventDefault();
        if (e.key === 'Escape') return;

        const keys = [];
        if (isMac) {
            if (e.metaKey) keys.push('CommandOrControl');
            if (e.ctrlKey) keys.push('Ctrl');
        } else {
            if (e.ctrlKey) keys.push('CommandOrControl');
        }

        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');

        let code = e.code;
        if (code.startsWith('Key')) code = code.slice(3);
        if (code.startsWith('Digit')) code = code.slice(5);

        if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;

        keys.push(code.toUpperCase());

        const displayKeys = keys.map(k => {
            if (k === 'CommandOrControl') return isMac ? 'Cmd' : 'Ctrl';
            if (k === 'Control') return 'Ctrl';
            if (k === 'Option') return 'Option';
            return k;
        });

        element.value = displayKeys.join(' + ');
        callback(keys.join('+'));
    });
}
