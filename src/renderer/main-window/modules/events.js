import { elements } from './dom.js';
import { hideModal, confirmAction, settleConfirm } from './modals.js';
import { renderHistory } from './history-renderer.js';
import { resetSelection } from './keyboard.js';
import { initSettingsUI, onSettingsShown, syncWidgetSection, revealWidgetSection } from './settings-ui.js';
import { isColorPopoverOpen, closeColorPopover } from './color-picker.js';
import {
    openNoteModal,
    closeNoteModal,
    showNoteEditMode,
    showNoteViewMode,
    getCurrentNoteItemId
} from './notes.js';
import { acceleratorFromEvent } from './accelerator.js';

// Runtime strings go through the shared dictionary; static markup is handled by
// shared/i18n.js at load. Guarded so the module still parses under Node (tests).
const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

let state = {
    history: [],
    favorites: [],
    activeTab: 'all',
    searchQuery: ''
};

// When the window is hidden we defer the (expensive) full list re-render and flush it
// once on visibilitychange. State above is always kept current.
let pendingRender = false;

// Registered at module load (before the async startup IIFE's awaits) so a render deferred
// during startup is never missed when the window is first shown.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pendingRender) {
        pendingRender = false;
        render();
    }
});

function render() {
    renderHistory(state.history, state.favorites, state.activeTab, state.searchQuery);
}

export function initState(data) {
    state.history = data.history || [];
    state.favorites = data.favorites || [];
}

export function updateHistoryState(data) {
    if (data && typeof data === 'object' && 'history' in data) {
        state.history = data.history || [];
        state.favorites = data.favorites || [];
    } else {
        state.history = Array.isArray(data) ? data : []; // fallback if old format received
    }
    if (document.visibilityState === 'hidden') {
        pendingRender = true;
        return;
    }
    render();
}

// Grey out (and lock) a shortcut input when its switch is off.
export function applyShortcutEnabled(key, enabled) {
    const input = elements.shortcutInputsByKey[key];
    if (input) input.classList.toggle('disabled', !enabled);
    const toggle = elements.shortcutToggles[key];
    if (toggle) toggle.checked = !!enabled;
}

// ── Views ────────────────────────────────────────────────────────────────────────
const VIEW_TITLES = { gallery: 'Ekran Görüntüleri', settings: 'Ayarlar' };

function showView(view) {
    elements.app.dataset.view = view;
    if (view !== 'history') {
        elements.viewTitle.textContent = t(VIEW_TITLES[view] || '');
    }
    if (view === 'settings') onSettingsShown();
    if (view === 'history') focusSearch();
}

export function currentView() {
    return elements.app.dataset.view;
}

function focusSearch() {
    // Defer past the click/keystroke that got us here, or the field takes the focus and
    // then immediately loses it again to the element that was activated.
    requestAnimationFrame(() => {
        // The window can regain focus while a sub-view is open, and the search box is
        // inside the history view — focusing a display:none element silently does nothing
        // and would just steal focus from whatever the user was actually using.
        if (currentView() !== 'history') return;
        elements.searchInput.focus();
        elements.searchInput.select();
    });
}

// ── Search ───────────────────────────────────────────────────────────────────────
// A keystroke rebuilds every row, and maxItems goes up to 500. At typing speed that is
// several full rebuilds per second for a result the user hasn't finished asking for.
const SEARCH_DEBOUNCE_MS = 90;
let searchTimer = null;

function onSearchInput(value) {
    elements.searchClear.hidden = !value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        state.searchQuery = value.trim();
        // A new result set is a new list; keeping the old cursor would leave it pointing
        // at whatever happens to be in that position now.
        resetSelection();
        render();
    }, SEARCH_DEBOUNCE_MS);
}

function clearSearch() {
    elements.searchInput.value = '';
    elements.searchClear.hidden = true;
    clearTimeout(searchTimer);
    state.searchQuery = '';
    resetSelection();
    render();
}

function setTab(tab) {
    if (state.activeTab === tab) return;
    state.activeTab = tab;
    elements.tabBtns.forEach(b => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
    });
    resetSelection();
    render();
}

export function setupEventListeners() {
    // Tabs. The old handler waited 150ms mid-fade before it rendered, so every switch
    // felt like a load; the list is rebuilt in single-digit milliseconds.
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });

    elements.searchInput.addEventListener('input', (e) => onSearchInput(e.target.value));
    elements.searchClear.addEventListener('click', () => {
        clearSearch();
        elements.searchInput.focus();
    });

    // Window controls
    elements.minimizeBtn.addEventListener('click', () => window.api.closeWindow());
    // Showing the window puts the caret in the search box: this window is summoned by a
    // shortcut, so the hands are already on the keyboard. (It used to blur instead.)
    window.addEventListener('focus', focusSearch);

    // Navigation
    elements.galleryBtn.addEventListener('click', () => showView('gallery'));
    elements.settingsBtn.addEventListener('click', () => showView('settings'));
    elements.backBtn.addEventListener('click', () => showView('history'));

    initSettingsUI();

    // ── Note modal ───────────────────────────────────────────────────────────────
    elements.closeNoteBtn.addEventListener('click', closeNoteModal);
    elements.editNoteBtn.addEventListener('click', () => showNoteEditMode(elements.noteInput.value));

    // Copies the note itself, not the item it is attached to, and the window stays put
    // (see the 'copy-text' handler) — so the button confirms in place with the same 800ms
    // check swap the row copy button uses. The copy glyph is read back off the markup
    // rather than duplicated here, so the two can never drift apart.
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
        if (item && item.note) showNoteViewMode(item.note);
        else closeNoteModal();
    });

    elements.saveNoteBtn.addEventListener('click', () => {
        const id = getCurrentNoteItemId();
        if (!id) return;
        window.api.setItemNote(id, elements.noteInput.value.trim());
        closeNoteModal();
    });

    // ── Settings ─────────────────────────────────────────────────────────────────
    elements.updateBtn.addEventListener('click', () => {
        elements.updateBtn.classList.add('spinning');
        window.api.checkForUpdates();
        setTimeout(() => elements.updateBtn.classList.remove('spinning'), 3000);
    });

    // Main reloads every window (and rebuilds the tray) for language — each surface paints
    // its own strings at load, so there is no live re-render path to keep correct. Theme is
    // different: the stylesheets are token-driven, so main just tells every window to flip
    // data-theme — instant, and safe mid-capture.
    elements.themeSelect.addEventListener('change', (e) => window.api.setTheme(e.target.value));
    elements.languageSelect.addEventListener('change', (e) => window.api.setLanguage(e.target.value));
    elements.autostartCheck.addEventListener('change', (e) => window.api.setAutoStart(e.target.checked));
    elements.incognitoCheck.addEventListener('change', (e) => window.api.setClipboardPaused(e.target.checked));
    elements.videoQualitySelect.addEventListener('change', (e) => window.api.setVideoQuality(e.target.value));
    if (elements.micDeviceSelect) {
        elements.micDeviceSelect.addEventListener('change', (e) => window.api.setAudioMicDevice(e.target.value));
    }

    elements.widgetCheck.addEventListener('change', (e) => {
        window.api.setShowWidget(e.target.checked);
        revealWidgetSection(e.target.checked);
    });
    elements.widgetTransparentCheck.addEventListener('change', (e) => window.api.setWidgetTransparent(e.target.checked));
    elements.widgetOpacityInput.addEventListener('input', (e) => window.api.setWidgetOpacity(e.target.value));
    elements.widgetScaleInput.addEventListener('input', (e) => window.api.setWidgetScale(e.target.value));
    syncWidgetSection();

    elements.maxItemsInput.addEventListener('change', (e) => {
        const value = parseInt(e.target.value, 10);
        if (value > 0) window.api.setMaxItems(value);
    });
    elements.quickPasteCountInput.addEventListener('change', (e) => {
        const value = parseInt(e.target.value, 10);
        if (value > 0) window.api.setQuickPasteCount(value);
    });

    setupShortcutInput(elements.shortcutInput, (s) => window.api.setShortcut(s));
    setupShortcutInput(elements.imageShortcutInput, (s) => window.api.setImageShortcut(s));
    setupShortcutInput(elements.ocrShortcutInput, (s) => window.api.setOcrShortcut(s));
    setupShortcutInput(elements.colorShortcutInput, (s) => window.api.setColorShortcut(s));
    setupShortcutInput(elements.scrollShortcutInput, (s) => window.api.setScrollShortcut(s));
    setupShortcutInput(elements.videoShortcutInput, (s) => window.api.setVideoShortcut(s));
    setupShortcutInput(elements.pasteShortcutInput, (s) => window.api.setPasteShortcut(s));

    // Per-shortcut on/off. The binding itself is kept when switched off (the main process
    // just drops the OS registration), so the input keeps showing it — greyed out.
    Object.entries(elements.shortcutToggles).forEach(([key, toggle]) => {
        if (!toggle) return;
        toggle.addEventListener('change', (e) => {
            window.api.setShortcutEnabled(key, e.target.checked);
            applyShortcutEnabled(key, e.target.checked);
        });
    });

    // The shared confirm dialog: both buttons answer the pending confirmAction().
    elements.confirmCancel.addEventListener('click', () => settleConfirm(false));
    elements.confirmOk.addEventListener('click', () => settleConfirm(true));

    elements.clearBtn.addEventListener('click', async () => {
        const ok = await confirmAction({
            title: t('Geçmişi temizle'),
            text: t('Tüm geçmiş silinecek. Favorileriniz etkilenmez.'),
            confirmLabel: t('Sil')
        });
        if (ok) window.api.clearHistory();
    });

    // ── Global keys ──────────────────────────────────────────────────────────────
    // Escape unwinds one layer at a time instead of always dismissing the window: a modal,
    // then a sub-view, then the search text, and only then the window itself. List
    // navigation lives in keyboard.js.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const openModal = document.querySelector('.modal-overlay:not(.hidden)');
            // The colour popover is the innermost layer, so it unwinds first.
            if (isColorPopoverOpen()) closeColorPopover();
            else if (openModal === elements.noteModal) closeNoteModal();
            // Not hideModal(): the confirm dialog has someone awaiting an answer, and
            // hiding it without one would leave that promise pending for good.
            else if (openModal === elements.confirmModal) settleConfirm(false);
            else if (openModal) hideModal(openModal);
            else if (currentView() !== 'history') showView('history');
            else if (elements.searchInput.value) clearSearch();
            else window.api.closeWindow();
            return;
        }

        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key === ',') {
            e.preventDefault();
            showView(currentView() === 'settings' ? 'history' : 'settings');
            return;
        }
        if (mod && (e.key === '1' || e.key === '2')) {
            e.preventDefault();
            showView('history');
            setTab(e.key === '1' ? 'all' : 'favorites');
            return;
        }
        if (mod && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            showView('history');
            focusSearch();
            return;
        }

        const isMac = navigator.platform.toUpperCase().includes('MAC');
        if (e.altKey && (isMac ? e.code === 'KeyU' : e.key.toLowerCase() === 'u')) {
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
        e.stopPropagation(); // recording a binding must not also trigger the global keys above

        const result = acceleratorFromEvent(e, isMac);
        if (result.ignore) return;
        if (result.error) { flashHint(result.error); return; }

        clearTimeout(hintTimer); // a pending restore would wipe the binding just accepted
        hintTimer = null;
        element.value = lastBinding = result.display;
        callback(result.accelerator);
    });
}

// The window was just re-shown: back to a clean "Tümü", no filter, cursor at the top.
// Written out rather than composed from clearSearch()+setTab(), which would render twice.
export function resetSearchState() {
    clearTimeout(searchTimer);
    elements.searchInput.value = '';
    elements.searchClear.hidden = true;
    state.searchQuery = '';
    state.activeTab = 'all';
    elements.tabBtns.forEach(b => {
        const on = b.dataset.tab === 'all';
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
    });
    resetSelection();
    render();
}
