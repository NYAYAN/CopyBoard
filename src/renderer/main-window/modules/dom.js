const $ = (id) => document.getElementById(id);

export const elements = {
    // Shell
    app: $('app'),
    backBtn: $('back-btn'),
    viewTitle: $('view-title'),
    galleryBtn: $('gallery-btn'),
    settingsBtn: $('settings-btn'),
    minimizeBtn: $('minimize-btn'),

    // History view
    listElement: $('history-list'),
    searchInput: $('search-input'),
    searchClear: $('search-clear'),
    statusCount: $('status-count'),
    tabBtns: document.querySelectorAll('.seg[data-tab]'),

    // Screenshot gallery
    galleryPanel: $('gallery-panel'),
    galleryGrid: $('gallery-grid'),
    galleryCount: $('gallery-count'),
    galleryFolderBtn: $('gallery-folder-btn'),
    galleryViewBtn: $('gallery-view-btn'),
    galleryLayout1: $('gallery-layout-1'),
    galleryLayout2: $('gallery-layout-2'),

    // Settings
    settingsPanel: $('settings-panel'),
    settingsSearch: $('settings-search'),
    settingsNoMatch: $('settings-no-match'),
    themeSelect: $('theme-select'),
    languageSelect: $('language-select'),
    maxItemsInput: $('max-items'),
    quickPasteCountInput: $('quickpaste-count'),
    incognitoCheck: $('incognito-check'),
    videoQualitySelect: $('video-quality'),
    micDeviceSelect: $('audio-mic-device'),
    autostartCheck: $('autostart-check'),
    updateBtn: $('update-btn'),
    aboutVersion: $('about-version'),
    clearBtn: $('clear-history-btn'),

    // Widget group — the one section whose body is conditional on its own switch
    widgetToggle: $('widget-toggle'),
    widgetCheck: $('widget-check'),
    widgetTransparentCheck: $('widget-transparent-check'),
    widgetOpacityInput: $('widget-opacity-input'),
    widgetScaleInput: $('widget-scale-input'),

    // In-window colour picker (see modules/color-picker.js)
    widgetColorBtn: $('widget-color-btn'),
    widgetColorDot: $('widget-color-dot'),
    colorPopover: $('color-popover'),
    cpSwatches: $('cp-swatches'),
    cpHue: $('cp-hue'),
    cpHex: $('cp-hex'),

    // Shortcuts, keyed by the same names the main process uses
    shortcutInput: $('shortcut-input'),
    imageShortcutInput: $('image-shortcut-input'),
    ocrShortcutInput: $('ocr-shortcut-input'),
    colorShortcutInput: $('color-shortcut-input'),
    scrollShortcutInput: $('scroll-shortcut-input'),
    videoShortcutInput: $('video-shortcut-input'),
    pasteShortcutInput: $('paste-shortcut-input'),
    shortcutInputsByKey: {
        list: $('shortcut-input'),
        draw: $('image-shortcut-input'),
        ocr: $('ocr-shortcut-input'),
        color: $('color-shortcut-input'),
        scroll: $('scroll-shortcut-input'),
        video: $('video-shortcut-input'),
        paste: $('paste-shortcut-input')
    },
    shortcutToggles: {
        list: $('shortcut-enabled'),
        draw: $('image-shortcut-enabled'),
        ocr: $('ocr-shortcut-enabled'),
        color: $('color-shortcut-enabled'),
        scroll: $('scroll-shortcut-enabled'),
        video: $('video-shortcut-enabled'),
        paste: $('paste-shortcut-enabled')
    },

    // Modals
    confirmModal: $('confirm-modal'),
    confirmTitle: $('confirm-title'),
    confirmText: $('confirm-text'),
    confirmOk: $('confirm-ok'),
    confirmCancel: $('confirm-cancel'),
    noteModal: $('note-modal'),
    noteModalTitle: $('note-modal-title'),
    noteViewContent: $('note-view-content'),
    noteInput: $('note-input'),
    noteViewActions: $('note-view-actions'),
    noteEditActions: $('note-edit-actions'),
    closeNoteBtn: $('close-note-btn'),
    copyNoteBtn: $('copy-note-btn'),
    editNoteBtn: $('edit-note-btn'),
    saveNoteBtn: $('save-note-btn'),
    cancelNoteBtn: $('cancel-note-btn')
};
