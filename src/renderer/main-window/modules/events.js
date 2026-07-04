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
    favorites: [],
    activeTab: 'all',
    searchQuery: ''
};

// When the window is hidden we defer the (expensive) full list re-render and
// flush it once on visibilitychange. State above is always kept current.
let pendingRender = false;

// Registered at module load (before the async startup IIFE's awaits) so a render
// deferred during startup is never missed when the window is first shown.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pendingRender) {
        pendingRender = false;
        renderHistory(state.history, state.favorites, state.activeTab, state.searchQuery);
    }
});

export function initState(data) {
    state.history = data.history || [];
    state.favorites = data.favorites || [];
}

export function updateHistoryState(data) {
    if (data && typeof data === 'object' && 'history' in data) {
        state.history = data.history || [];
        state.favorites = data.favorites || [];
    } else {
        // Fallback if old format received
        state.history = Array.isArray(data) ? data : [];
    }
    // Skip the full DOM rebuild while hidden; re-render when the window is shown.
    if (document.visibilityState === 'hidden') {
        pendingRender = true;
        return;
    }
    renderHistory(state.history, state.favorites, state.activeTab, state.searchQuery);
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
                renderHistory(state.history, state.favorites, state.activeTab, state.searchQuery);

                setTimeout(() => {
                    elements.listElement.classList.remove('tab-switching');
                }, 50);
            }, 150);
        });
    });

    // Search
    elements.searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim();
        renderHistory(state.history, state.favorites, state.activeTab, state.searchQuery);
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
    // Ctrl/Cmd+Enter confirms; plain Enter stays a newline (multi-line textarea).
    elements.manualTextInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            elements.confirmAddBtn.click();
        }
    });

    // Note Modal
    elements.closeNoteBtn.addEventListener('click', closeNoteModal);
    elements.editNoteBtn.addEventListener('click', () => showNoteEditMode(elements.noteInput.value));
    elements.cancelNoteBtn.addEventListener('click', () => {
        // Notes are opened from the favorites tab, so look there first; fall back to history.
        const id = getCurrentNoteItemId();
        const item = state.favorites.find(i => i.id === id) || state.history.find(i => i.id === id);
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

    elements.updateBtn.addEventListener('click', () => {
        elements.updateBtn.classList.add('spinning');
        window.api.checkForUpdates();
        setTimeout(() => elements.updateBtn.classList.remove('spinning'), 3000);
    });

    // Inputs
    elements.autostartCheck.addEventListener('change', (e) => window.api.setAutoStart(e.target.checked));
    elements.incognitoCheck.addEventListener('change', (e) => window.api.setClipboardPaused(e.target.checked));
    elements.widgetCheck.addEventListener('change', (e) => {
        window.api.setShowWidget(e.target.checked);
        elements.widgetExtraSettings.style.display = e.target.checked ? 'flex' : 'none';
    });
    elements.widgetTransparentCheck.addEventListener('change', (e) => window.api.setWidgetTransparent(e.target.checked));
    elements.widgetColorInput.addEventListener('input', (e) => window.api.setWidgetColor(e.target.value));
    elements.widgetOpacityInput.addEventListener('input', (e) => window.api.setWidgetOpacity(e.target.value));
    elements.widgetScaleInput.addEventListener('input', (e) => window.api.setWidgetScale(e.target.value));
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
        if (e.key === 'Escape') {
            // Close an open modal first; only hide the window if no modal is open.
            const openModal = document.querySelector('.modal-overlay:not(.hidden)');
            if (openModal === elements.noteModal) {
                closeNoteModal();
            } else if (openModal) {
                hideModal(openModal);
            } else {
                window.api.closeWindow();
            }
        }
        const isMac = navigator.platform.toUpperCase().includes('MAC');
        if (e.altKey && (isMac ? e.code === 'KeyU' : e.key.toLowerCase() === 'u')) {
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

export function resetSearchState() {
    state.searchQuery = '';
    if (elements.searchInput) elements.searchInput.value = '';
    
    // Reset tabs to 'all'
    state.activeTab = 'all';
    elements.tabBtns.forEach(b => {
        if (b.dataset.tab === 'all') b.classList.add('active');
        else b.classList.remove('active');
    });

    renderHistory(state.history, state.favorites, state.activeTab, state.searchQuery);
}
