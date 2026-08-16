export const elements = {
    listElement: document.getElementById('history-list'),
    settingsBtn: document.getElementById('settings-btn'),
    aboutBtn: document.getElementById('about-btn'),
    updateBtn: document.getElementById('update-btn'),
    historyBtn: document.getElementById('history-btn'),
    settingsPanel: document.getElementById('settings-panel'),
    aboutPanel: document.getElementById('about-panel'),
    widgetToggle: document.getElementById('widget-toggle'), // the one group with a condition

    // Screenshot gallery
    galleryBtn: document.getElementById('gallery-btn'),
    galleryPanel: document.getElementById('gallery-panel'),
    galleryGrid: document.getElementById('gallery-grid'),
    galleryFolderBtn: document.getElementById('gallery-folder-btn'),
    galleryViewBtn: document.getElementById('gallery-view-btn'),
    galleryLayout1: document.getElementById('gallery-layout-1'),
    galleryLayout2: document.getElementById('gallery-layout-2'),
    aboutVersion: document.getElementById('about-version'),
    maxItemsInput: document.getElementById('max-items'),
    quickPasteCountInput: document.getElementById('quickpaste-count'),
    shortcutInput: document.getElementById('shortcut-input'),
    imageShortcutInput: document.getElementById('image-shortcut-input'),
    ocrShortcutInput: document.getElementById('ocr-shortcut-input'),
    colorShortcutInput: document.getElementById('color-shortcut-input'),
    videoShortcutInput: document.getElementById('video-shortcut-input'),
    pasteShortcutInput: document.getElementById('paste-shortcut-input'),
    // Per-shortcut on/off switches (keyed by the same name the main process uses)
    shortcutToggles: {
        list: document.getElementById('shortcut-enabled'),
        draw: document.getElementById('image-shortcut-enabled'),
        ocr: document.getElementById('ocr-shortcut-enabled'),
        color: document.getElementById('color-shortcut-enabled'),
        video: document.getElementById('video-shortcut-enabled'),
        paste: document.getElementById('paste-shortcut-enabled')
    },
    shortcutInputsByKey: {
        list: document.getElementById('shortcut-input'),
        draw: document.getElementById('image-shortcut-input'),
        ocr: document.getElementById('ocr-shortcut-input'),
        color: document.getElementById('color-shortcut-input'),
        video: document.getElementById('video-shortcut-input'),
        paste: document.getElementById('paste-shortcut-input')
    },
    videoQualitySelect: document.getElementById('video-quality'),
    clearBtn: document.getElementById('clear-history-btn'),
    confirmModal: document.getElementById('confirm-modal'),
    confirmClearBtn: document.getElementById('confirm-clear-btn'),
    cancelClearBtn: document.getElementById('cancel-clear-btn'),
    minimizeBtn: document.getElementById('minimize-btn'),

    // Note Modal
    noteModal: document.getElementById('note-modal'),
    noteModalTitle: document.getElementById('note-modal-title'),
    noteViewContent: document.getElementById('note-view-content'),
    noteInput: document.getElementById('note-input'),
    noteViewActions: document.getElementById('note-view-actions'),
    noteEditActions: document.getElementById('note-edit-actions'),
    closeNoteBtn: document.getElementById('close-note-btn'),
    copyNoteBtn: document.getElementById('copy-note-btn'),
    editNoteBtn: document.getElementById('edit-note-btn'),
    saveNoteBtn: document.getElementById('save-note-btn'),
    cancelNoteBtn: document.getElementById('cancel-note-btn'),

    // Search
    searchInput: document.getElementById('search-input'),

    // Other
    tabBtns: document.querySelectorAll('.tab-btn'),
    themeSelect: document.getElementById('theme-select'),
    languageSelect: document.getElementById('language-select'),
    autostartCheck: document.getElementById('autostart-check'),
    incognitoCheck: document.getElementById('incognito-check'),
    widgetCheck: document.getElementById('widget-check'),
    widgetExtraSettings: document.getElementById('widget-extra-settings'),
    widgetTransparentCheck: document.getElementById('widget-transparent-check'),
    widgetColorInput: document.getElementById('widget-color-input'),
    widgetOpacityInput: document.getElementById('widget-opacity-input'),
    widgetScaleInput: document.getElementById('widget-scale-input')
};
