import { initState, setupEventListeners, updateHistoryState, resetSearchState } from './modules/events.js';
import { renderHistory } from './modules/history-renderer.js';
import { elements } from './modules/dom.js';

(async () => {
    // 1. Load Initial Data
    const history = await window.api.getHistory();
    const settings = await window.api.getSettings();

    // 2. Initialize State
    initState(history);

    // 3. UI Setup from Settings
    elements.maxItemsInput.value = settings.maxItems;
    elements.quickPasteCountInput.value = settings.quickPasteCount;
    elements.autostartCheck.checked = settings.autoStart;
    elements.incognitoCheck.checked = settings.clipboardPaused || false;
    elements.widgetCheck.checked = settings.showWidget;
    elements.widgetTransparentCheck.checked = settings.widgetTransparent;
    elements.widgetColorInput.value = settings.widgetColor || '#8957e5';
    elements.widgetOpacityInput.value = settings.widgetOpacity !== undefined ? settings.widgetOpacity : 100;
    elements.widgetScaleInput.value = settings.widgetScale !== undefined ? settings.widgetScale : 100;

    // Toggle extra settings visibility on load
    if (settings.showWidget) {
        elements.widgetExtraSettings.style.display = 'flex';
    } else {
        elements.widgetExtraSettings.style.display = 'none';
    }

    // Formatting Helpers for Shortcuts
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    function format(s) {
        return s ? s.split('+').map(k => {
            if (k === 'CommandOrControl') return isMac ? 'Cmd' : 'Ctrl';
            if (k === 'Control') return 'Ctrl';
            if (k === 'Option') return 'Option';
            return k;
        }).join(' + ') : '';
    }

    elements.shortcutInput.value = format(settings.globalShortcut);
    elements.imageShortcutInput.value = format(settings.globalShortcutImage);
    elements.ocrShortcutInput.value = format(settings.globalShortcutOcr);
    elements.videoShortcutInput.value = format(settings.globalShortcutVideo);
    elements.pasteShortcutInput.value = format(settings.globalShortcutPaste);
    if (settings.videoQuality) elements.videoQualitySelect.value = settings.videoQuality;

    // 4. Render Initial History
    renderHistory(history.history || [], history.favorites || [], 'all');

    // 5. Setup Listeners
    setupEventListeners();
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
