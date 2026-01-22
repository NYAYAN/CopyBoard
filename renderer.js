const listElement = document.getElementById('history-list');
const settingsBtn = document.getElementById('settings-btn');
const aboutBtn = document.getElementById('about-btn');
const addManualBtn = document.getElementById('add-manual-btn');
const settingsPanel = document.getElementById('settings-panel');
const aboutPanel = document.getElementById('about-panel');
const maxItemsInput = document.getElementById('max-items');
const shortcutInput = document.getElementById('shortcut-input');
const imageShortcutInput = document.getElementById('image-shortcut-input');
const ocrShortcutInput = document.getElementById('ocr-shortcut-input');
const videoShortcutInput = document.getElementById('video-shortcut-input');
const videoQualitySelect = document.getElementById('video-quality');
const clearBtn = document.getElementById('clear-history-btn');
const confirmModal = document.getElementById('confirm-modal');
const confirmClearBtn = document.getElementById('confirm-clear-btn');
const cancelClearBtn = document.getElementById('cancel-clear-btn');
const minimizeBtn = document.getElementById('minimize-btn');
const addItemModal = document.getElementById('add-item-modal');
const manualTextInput = document.getElementById('manual-text-input');
const confirmAddBtn = document.getElementById('confirm-add-btn');
const cancelAddBtn = document.getElementById('cancel-add-btn');

// Note Modal Elements
// Note Modal Elements
const noteModal = document.getElementById('note-modal');
const noteModalTitle = document.getElementById('note-modal-title');
const noteViewContent = document.getElementById('note-view-content');
const noteInput = document.getElementById('note-input');
const noteViewActions = document.getElementById('note-view-actions');
const noteEditActions = document.getElementById('note-edit-actions');

const closeNoteBtn = document.getElementById('close-note-btn');
const editNoteBtn = document.getElementById('edit-note-btn');
const saveNoteBtn = document.getElementById('save-note-btn');
const cancelNoteBtn = document.getElementById('cancel-note-btn');

let currentNoteItemId = null;

const tabBtns = document.querySelectorAll('.tab-btn');

let currentHistory = [];
let activeTab = 'all';

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (activeTab === btn.dataset.tab) return;

        listElement.classList.add('tab-switching');

        setTimeout(() => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeTab = btn.dataset.tab;
            renderHistory(currentHistory);

            // Reflow'u tetikle ve animasyonu geri al
            setTimeout(() => {
                listElement.classList.remove('tab-switching');
            }, 50);
        }, 150);
    });
});

minimizeBtn.addEventListener('click', () => window.api.closeWindow());

window.addEventListener('focus', () => {
    if (document.activeElement) document.activeElement.blur();
});

addManualBtn.addEventListener('click', () => {
    addItemModal.classList.remove('hidden');
    manualTextInput.value = '';
    manualTextInput.focus();
});

cancelAddBtn.addEventListener('click', () => addItemModal.classList.add('hidden'));

confirmAddBtn.addEventListener('click', () => {
    const text = manualTextInput.value.trim();
    if (text) {
        window.api.addManualItem(text);
        addItemModal.classList.add('hidden');
    }
});

// Note UI Handlers
// Note UI Handlers
function openNoteModal(item) {
    currentNoteItemId = item.id;
    noteModal.classList.remove('hidden');

    if (item.note && item.note.trim().length > 0) {
        // VIEW MODE
        showNoteViewMode(item.note);
    } else {
        // EDIT MODE (New Note)
        showNoteEditMode('');
    }
}

function showNoteViewMode(text) {
    noteModalTitle.textContent = 'Not';
    noteViewContent.textContent = text;
    noteInput.value = text; // Keep sync for edit

    noteViewContent.classList.remove('hidden');
    noteInput.classList.add('hidden');

    noteViewActions.classList.remove('hidden');
    noteEditActions.classList.add('hidden');
}

function showNoteEditMode(text) {
    noteModalTitle.textContent = text ? 'Notu Düzenle' : 'Not Ekle';
    noteInput.value = text;

    noteViewContent.classList.add('hidden');
    noteInput.classList.remove('hidden');

    noteViewActions.classList.add('hidden');
    noteEditActions.classList.remove('hidden');

    noteInput.focus();
}

// Button Listeners
closeNoteBtn.addEventListener('click', () => {
    noteModal.classList.add('hidden');
    currentNoteItemId = null;
});

editNoteBtn.addEventListener('click', () => {
    showNoteEditMode(noteInput.value);
});

cancelNoteBtn.addEventListener('click', () => {
    // If it was an existing note, go back to view mode? 
    // Or just close? User requested "Close" or "Edit".
    // Usually Cancel in edit mode implies "Stop editing, revert".
    const item = currentHistory.find(i => i.id === currentNoteItemId);

    if (item && item.note) {
        showNoteViewMode(item.note);
    } else {
        noteModal.classList.add('hidden');
        currentNoteItemId = null;
    }
});

saveNoteBtn.addEventListener('click', () => {
    if (currentNoteItemId) {
        const note = noteInput.value.trim();
        window.api.setItemNote(currentNoteItemId, note);
        // After save, close modal or switch to view? 
        // User asked "edit demeden direk kapat diyebilmeliyim" -> implies flow is flexible.
        // Standard UX: Save closes modal.
        noteModal.classList.add('hidden');
        currentNoteItemId = null;
    }
});

settingsBtn.addEventListener('click', () => {
    aboutPanel.classList.add('hidden');
    aboutBtn.classList.remove('active');
    settingsPanel.classList.toggle('hidden');
    settingsBtn.classList.toggle('active');
});

aboutBtn.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
    settingsBtn.classList.remove('active');
    aboutPanel.classList.toggle('hidden');
    aboutBtn.classList.toggle('active');
});

document.getElementById('autostart-check').addEventListener('change', (e) => {
    window.api.setAutoStart(e.target.checked);
});

maxItemsInput.addEventListener('change', (e) => {
    const value = parseInt(e.target.value);
    if (value > 0) window.api.setMaxItems(value);
});

// Detect platform
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

function setupShortcutInput(element, callback) {
    element.addEventListener('keydown', (e) => {
        e.preventDefault();

        // ESC tuşunu yasakla
        if (e.key === 'Escape') return;

        const keys = [];

        // Platform specific modifier handling for CommandOrControl
        if (isMac) {
            if (e.metaKey) keys.push('CommandOrControl');
            if (e.ctrlKey) keys.push('Ctrl');
        } else {
            if (e.ctrlKey) keys.push('CommandOrControl');
        }

        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');

        // Use e.code to avoid locale specific characters (e.g. Option+V = √ on Mac)
        let code = e.code;
        if (code.startsWith('Key')) code = code.slice(3);
        if (code.startsWith('Digit')) code = code.slice(5);

        // Ignore modifier key presses themselves (e.g. just pressing Cmd)
        if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;

        keys.push(code.toUpperCase());

        // Display logic
        const displayKeys = keys.map(k => {
            if (k === 'CommandOrControl') return isMac ? 'Cmd' : 'Ctrl';
            if (k === 'Control') return 'Ctrl'; // Or '⌃'
            if (k === 'Option') return 'Option'; // Or '⌥'
            return k;
        });

        element.value = displayKeys.join(' + ');
        callback(keys.join('+'));
    });
}

setupShortcutInput(shortcutInput, (s) => window.api.setShortcut(s));
setupShortcutInput(imageShortcutInput, (s) => window.api.setImageShortcut(s));
setupShortcutInput(ocrShortcutInput, (s) => window.api.setOcrShortcut(s));
setupShortcutInput(videoShortcutInput, (s) => window.api.setVideoShortcut(s));

videoQualitySelect.addEventListener('change', (e) => window.api.setVideoQuality(e.target.value));

clearBtn.addEventListener('click', () => confirmModal.classList.remove('hidden'));
cancelClearBtn.addEventListener('click', () => confirmModal.classList.add('hidden'));
confirmClearBtn.addEventListener('click', () => {
    window.api.clearHistory();
    confirmModal.classList.add('hidden');
});

function getFilteredHistory(history) {
    if (activeTab === 'favorites') {
        return history.filter(i => i.isFavorite);
    }
    return history.filter(i => !i.hiddenFromHistory);
}

let dragStartIndex;

function onDragStart(e) {
    if (activeTab !== 'favorites') return;
    dragStartIndex = +this.getAttribute('data-list-index');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
    this.classList.add('dragging');
}

function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function onDrop(e) {
    e.stopPropagation();
    if (activeTab !== 'favorites') return;

    const dragEndIndex = +this.getAttribute('data-list-index');
    const item = this;

    if (dragStartIndex !== dragEndIndex) {
        swapFavorites(dragStartIndex, dragEndIndex);
        item.classList.remove('dragging');
    }
}

function swapFavorites(fromIndex, toIndex) {
    const favorites = currentHistory.filter(i => i.isFavorite);
    const itemA = favorites[fromIndex];
    const itemB = favorites[toIndex];
    const realIndexA = currentHistory.findIndex(i => i.id === itemA.id);
    const realIndexB = currentHistory.findIndex(i => i.id === itemB.id);

    const temp = currentHistory[realIndexA];
    currentHistory[realIndexA] = currentHistory[realIndexB];
    currentHistory[realIndexB] = temp;

    window.api.reorderHistory(currentHistory);
    renderHistory(currentHistory);
}

function renderHistory(history) {
    listElement.innerHTML = '';
    currentHistory = history;

    const filtered = getFilteredHistory(history);

    if (filtered.length === 0) {
        listElement.innerHTML = '<div class="empty-state">Liste boş.</div>';
        return;
    }

    filtered.forEach((item, index) => {
        const itemContent = item.content;
        const itemDate = item.timestamp ? new Date(item.timestamp) : new Date();

        const dateStr = itemDate.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = itemDate.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        const metaText = `${dateStr} ${timeStr}`;

        const domItem = document.createElement('div');
        domItem.className = 'history-item';
        domItem.setAttribute('data-list-index', index);
        domItem.title = itemContent; // Show full content on hover

        if (activeTab === 'favorites') {
            domItem.classList.add('favorites-tab');
            domItem.setAttribute('draggable', 'true');
            domItem.addEventListener('dragstart', onDragStart);
            domItem.addEventListener('dragover', onDragOver);
            domItem.addEventListener('drop', onDrop);
            domItem.addEventListener('dragend', () => domItem.classList.remove('dragging'));
        }

        if (activeTab === 'favorites') {
            const dragHandle = document.createElement('span');
            dragHandle.className = 'drag-handle';
            dragHandle.innerHTML = '⋮⋮';
            domItem.appendChild(dragHandle);
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'history-content';

        const textSpan = document.createElement('span');
        textSpan.className = 'history-text';
        textSpan.textContent = itemContent;

        const metaSpan = document.createElement('small');
        metaSpan.className = 'history-meta';
        metaSpan.textContent = metaText;

        contentDiv.appendChild(textSpan);
        contentDiv.appendChild(metaSpan);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'history-actions';

        if (activeTab === 'favorites') {
            const infoBtn = document.createElement('button');
            infoBtn.className = `action-btn info-btn ${item.note ? 'has-note' : ''}`;
            infoBtn.innerHTML = item.note ? '📝' : 'ℹ️'; // Icon changes if note exists
            infoBtn.title = item.note ? 'Notu Düzenle' : 'Not Ekle';
            if (item.note) infoBtn.title += `\nNot: ${item.note.substring(0, 50)}${item.note.length > 50 ? '...' : ''}`;

            infoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openNoteModal(item);
            });
            actionsDiv.appendChild(infoBtn);
        }

        const starBtn = document.createElement('button');
        starBtn.className = `action-btn star-btn ${item.isFavorite ? 'active' : ''}`;
        starBtn.innerHTML = item.isFavorite ? '⭐' : '☆';
        starBtn.title = item.isFavorite ? 'Favorilerden Çıkar' : 'Favorilere Ekle';
        starBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.api.toggleFavorite(item.id);
        });

        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn copy-btn';
        copyBtn.innerHTML = '📋';
        copyBtn.title = 'Kopyala';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Animate only this button
            copyBtn.innerHTML = '✅';
            setTimeout(() => { copyBtn.innerHTML = '📋'; }, 800);
            window.api.copyItem(itemContent);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn delete-btn';
        deleteBtn.innerHTML = '✕';
        deleteBtn.title = 'Sil';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.api.deleteHistoryItem(item.id, activeTab);
        });

        actionsDiv.appendChild(starBtn);
        actionsDiv.appendChild(copyBtn);
        actionsDiv.appendChild(deleteBtn);

        domItem.appendChild(contentDiv);
        domItem.appendChild(actionsDiv);

        domItem.addEventListener('click', (e) => {
            if (e.target.closest('.action-btn')) return;
            domItem.classList.add('copied');
            copyBtn.innerHTML = '✅';
            setTimeout(() => {
                domItem.classList.remove('copied');
                copyBtn.innerHTML = '📋';
            }, 800);
            window.api.copyItem(itemContent);
        });

        listElement.appendChild(domItem);
    });
}

(async () => {
    const history = await window.api.getHistory();
    const settings = await window.api.getSettings();
    maxItemsInput.value = settings.maxItems;
    document.getElementById('autostart-check').checked = settings.autoStart;

    function format(s) {
        return s ? s.split('+').map(k => {
            if (k === 'CommandOrControl') return isMac ? 'Cmd' : 'Ctrl';
            if (k === 'Control') return 'Ctrl';
            if (k === 'Option') return 'Option';
            return k;
        }).join(' + ') : '';
    }

    shortcutInput.value = format(settings.globalShortcut);
    imageShortcutInput.value = format(settings.globalShortcutImage);
    ocrShortcutInput.value = format(settings.globalShortcutOcr);
    videoShortcutInput.value = format(settings.globalShortcutVideo);
    if (settings.videoQuality) videoQualitySelect.value = settings.videoQuality;

    renderHistory(history);
})();

window.api.onUpdateHistory((history) => {
    currentHistory = history;
    renderHistory(history);
});

const toastElement = document.getElementById('toast');
let toastTimeout;
window.api.onShowToast((message, type) => {
    toastElement.textContent = message;
    toastElement.className = `toast visible ${type}`;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastElement.className = 'toast hidden', 3000);
});

window.api.onResetView(() => {
    // Close panels
    settingsPanel.classList.add('hidden');
    aboutPanel.classList.add('hidden');
    settingsBtn.classList.remove('active');
    aboutBtn.classList.remove('active');
    addItemModal.classList.add('hidden');

    // Close Note Modal
    noteModal.classList.add('hidden');
    currentNoteItemId = null;

    // Switch to 'all' tab if not already
    if (activeTab !== 'all') {
        const allTabBtn = document.querySelector('.tab-btn[data-tab="all"]');
        if (allTabBtn) allTabBtn.click();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.api.closeWindow();

    // --- Manual Update Check Shortcut (Alt+U) ---
    if (e.altKey && e.key.toLowerCase() === 'u') {
        console.log('Manual update check triggered via Alt+U');
        window.api.checkForUpdates();
    }
});
