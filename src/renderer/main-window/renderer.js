import { initState, setupEventListeners, updateHistoryState, resetSearchState, applyShortcutEnabled } from './modules/events.js';
import { renderHistory } from './modules/history-renderer.js';
import { initGallery } from './modules/gallery.js';
import { initTooltips } from './modules/tooltip.js';
import { elements } from './modules/dom.js';
import { keycapFor, applyLayoutMap } from './modules/accelerator.js';

(async () => {
    // 1. Load Initial Data
    const history = await window.api.getHistory();
    const settings = await window.api.getSettings();

    // 2. Initialize State
    initState(history);

    // 3. UI Setup from Settings
    elements.maxItemsInput.value = settings.maxItems;
    elements.quickPasteCountInput.value = settings.quickPasteCount;
    if (settings.appVersion && elements.aboutVersion) elements.aboutVersion.textContent = `CopyBoard v${settings.appVersion}`;
    elements.themeSelect.value = window.api.theme || 'dark';
    elements.languageSelect.value = (window.api.i18n && window.api.i18n.lang) || 'tr';
    elements.autostartCheck.checked = settings.autoStart;
    elements.incognitoCheck.checked = settings.clipboardPaused || false;
    elements.widgetCheck.checked = settings.showWidget;
    elements.widgetTransparentCheck.checked = settings.widgetTransparent;
    elements.widgetColorInput.value = settings.widgetColor || '#8957e5';
    elements.widgetOpacityInput.value = settings.widgetOpacity !== undefined ? settings.widgetOpacity : 100;
    elements.widgetScaleInput.value = settings.widgetScale !== undefined ? settings.widgetScale : 100;

    // The widget's settings start folded away (setupEventListeners wires the disclosure
    // and syncs it to the checkbox above).

    // Formatting Helpers for Shortcuts
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    // Bindings on keys Electron can't name are stored as their physical code
    // (…+IntlBackslash). Ask the OS what this keyboard actually prints on those, so the
    // field reads Cmd + " rather than Cmd + IntlBackslash.
    try { applyLayoutMap(await navigator.keyboard.getLayoutMap()); } catch (e) { /* fallbacks */ }
    function format(s) {
        return s ? s.split('+').map(k => {
            if (k === 'CommandOrControl') return isMac ? 'Cmd' : 'Ctrl';
            if (k === 'Control') return 'Ctrl';
            if (k === 'Option') return 'Option';
            return keycapFor(k);
        }).join(' + ') : '';
    }

    elements.shortcutInput.value = format(settings.globalShortcut);
    elements.imageShortcutInput.value = format(settings.globalShortcutImage);
    elements.ocrShortcutInput.value = format(settings.globalShortcutOcr);
    elements.colorShortcutInput.value = format(settings.globalShortcutColor);
    elements.videoShortcutInput.value = format(settings.globalShortcutVideo);
    elements.pasteShortcutInput.value = format(settings.globalShortcutPaste);
    if (settings.videoQuality) elements.videoQualitySelect.value = settings.videoQuality;

    const enabled = settings.shortcutsEnabled || {};
    ['list', 'draw', 'ocr', 'color', 'video', 'paste'].forEach(k => applyShortcutEnabled(k, enabled[k] !== false));

    // 4. Render Initial History
    renderHistory(history.history || [], history.favorites || [], 'all');

    // 5. Setup Listeners
    setupEventListeners();
    initGallery();
    initTooltips(); // native title tooltips are invisible in an always-on-top window
})();

// IPC Event Listeners
window.api.onUpdateHistory((history) => {
    updateHistoryState(history);
});

window.api.onResetView(() => {
    import('./modules/modals.js').then(({ resetView }) => {
        resetView();
        resetSearchState();
    });
});
