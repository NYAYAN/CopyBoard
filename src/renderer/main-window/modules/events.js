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
import { acceleratorFromEvent } from './accelerator.js';

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

// Grey out (and lock) a shortcut input when its switch is off.
export function applyShortcutEnabled(key, enabled) {
    const input = elements.shortcutInputsByKey[key];
    if (input) input.classList.toggle('disabled', !enabled);
    const toggle = elements.shortcutToggles[key];
    if (toggle) toggle.checked = !!enabled;
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

    // Note Modal
    elements.closeNoteBtn.addEventListener('click', closeNoteModal);
    elements.editNoteBtn.addEventListener('click', () => showNoteEditMode(elements.noteInput.value));
    // Copies the note itself, not the item it's attached to. The window stays put (see the
    // 'copy-text' handler), so the icon confirms in place with the same 800ms check swap
    // the row copy button uses. The copy glyph is read back from the markup rather than
    // duplicated here, so the two never drift apart.
    const noteCopyIcon = elements.copyNoteBtn.innerHTML;
    const noteCheckIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    let noteCopyTimer = null;
    elements.copyNoteBtn.addEventListener('click', () => {
        const text = elements.noteViewContent.textContent;
        if (!text) return;
        window.api.copyText(text);
        elements.copyNoteBtn.innerHTML = noteCheckIcon;
        elements.copyNoteBtn.classList.add('copied');
        clearTimeout(noteCopyTimer);
        noteCopyTimer = setTimeout(() => {
            elements.copyNoteBtn.innerHTML = noteCopyIcon;
            elements.copyNoteBtn.classList.remove('copied');
        }, 800);
    });
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

    // Settings / About / Gallery — panels are mutually exclusive
    const closeGalleryPanel = () => {
        elements.galleryPanel.classList.add('hidden');
        elements.galleryBtn.classList.remove('active');
    };

    elements.settingsBtn.addEventListener('click', () => {
        elements.aboutPanel.classList.add('hidden');
        elements.aboutBtn.classList.remove('active');
        closeGalleryPanel();
        elements.settingsPanel.classList.toggle('hidden');
        elements.settingsBtn.classList.toggle('active');
    });

    elements.aboutBtn.addEventListener('click', () => {
        elements.settingsPanel.classList.add('hidden');
        elements.settingsBtn.classList.remove('active');
        closeGalleryPanel();
        elements.aboutPanel.classList.toggle('hidden');
        elements.aboutBtn.classList.toggle('active');
    });

    elements.galleryBtn.addEventListener('click', () => {
        elements.settingsPanel.classList.add('hidden');
        elements.settingsBtn.classList.remove('active');
        elements.aboutPanel.classList.add('hidden');
        elements.aboutBtn.classList.remove('active');
        elements.galleryPanel.classList.toggle('hidden');
        elements.galleryBtn.classList.toggle('active');
    });

    // Header "Geçmiş" button (replaces the removed manual-add "+"): closes whichever
    // panel is open (gallery/settings/about) and returns to the history list on the
    // Tümü tab — the mirror of the gallery button.
    elements.historyBtn.addEventListener('click', () => {
        elements.settingsPanel.classList.add('hidden');
        elements.settingsBtn.classList.remove('active');
        elements.aboutPanel.classList.add('hidden');
        elements.aboutBtn.classList.remove('active');
        closeGalleryPanel();
        if (state.activeTab !== 'all') {
            elements.tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === 'all'));
            state.activeTab = 'all';
            renderHistory(state.history, state.favorites, state.activeTab, state.searchQuery);
        }
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
    elements.quickPasteCountInput.addEventListener('change', (e) => {
        const value = parseInt(e.target.value);
        if (value > 0) window.api.setQuickPasteCount(value);
    });
    elements.videoQualitySelect.addEventListener('change', (e) => window.api.setVideoQuality(e.target.value));

    // Shortcut Inputs
    setupShortcutInput(elements.shortcutInput, (s) => window.api.setShortcut(s));
    setupShortcutInput(elements.imageShortcutInput, (s) => window.api.setImageShortcut(s));
    setupShortcutInput(elements.ocrShortcutInput, (s) => window.api.setOcrShortcut(s));
    setupShortcutInput(elements.colorShortcutInput, (s) => window.api.setColorShortcut(s));

    // Per-shortcut on/off. The binding itself is kept when switched off (main process
    // just drops the OS registration), so the input keeps showing it — greyed out.
    Object.entries(elements.shortcutToggles).forEach(([key, toggle]) => {
        if (!toggle) return;
        toggle.addEventListener('change', (e) => {
            window.api.setShortcutEnabled(key, e.target.checked);
            applyShortcutEnabled(key, e.target.checked);
        });
    });
    setupShortcutInput(elements.videoShortcutInput, (s) => window.api.setVideoShortcut(s));
    setupShortcutInput(elements.pasteShortcutInput, (s) => window.api.setPasteShortcut(s));

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

    // Briefly show a hint in the input, then restore the current binding. Reading the
    // binding back off the element only works while no hint is up — two rejections in a
    // row would otherwise capture the first hint as the "binding" and leave the field
    // stuck on an error message.
    let hintTimer = null;
    let lastBinding = element.value;
    const flashHint = (msg) => {
        if (!hintTimer) lastBinding = element.value;
        element.value = msg;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => { element.value = lastBinding; hintTimer = null; }, 1400);
    };

    element.addEventListener('keydown', (e) => {
        e.preventDefault();

        const result = acceleratorFromEvent(e, isMac);
        if (result.ignore) return;
        if (result.error) {
            flashHint(result.error);
            return;
        }

        // A pending hint restore would otherwise wipe the binding we just accepted.
        clearTimeout(hintTimer);
        hintTimer = null;
        element.value = lastBinding = result.display;
        callback(result.accelerator);
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
