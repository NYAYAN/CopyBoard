const listElement = document.getElementById('history-list');
const settingsBtn = document.getElementById('settings-btn');
const aboutBtn = document.getElementById('about-btn');
const settingsPanel = document.getElementById('settings-panel');
const aboutPanel = document.getElementById('about-panel');
const maxItemsInput = document.getElementById('max-items');
const shortcutInput = document.getElementById('shortcut-input');
const imageShortcutInput = document.getElementById('image-shortcut-input');
const clearBtn = document.getElementById('clear-history-btn');

// Helper for shortcut recording
function setupShortcutInput(element, callback) {
    element.addEventListener('keydown', (e) => {
        e.preventDefault();

        const keys = [];
        if (e.ctrlKey) keys.push('CommandOrControl');
        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');

        // Get code for regular keys (e.g. KeyV -> V, Digit1 -> 1)
        let key = e.key.toUpperCase();
        if (key === 'CONTROL' || key === 'ALT' || key === 'SHIFT' || key === 'META') return;

        keys.push(key);

        const shortcut = keys.join('+');
        element.value = shortcut;

        // Debounce/Commit
        callback(shortcut);
    });
}

// Toggle Settings
settingsBtn.addEventListener('click', () => {
    aboutPanel.classList.add('hidden'); // Close about if open
    settingsPanel.classList.toggle('hidden');
});

// Toggle About
aboutBtn.addEventListener('click', () => {
    settingsPanel.classList.add('hidden'); // Close settings if open
    aboutPanel.classList.toggle('hidden');
});

// Update Max Items
maxItemsInput.addEventListener('change', (e) => {
    const value = parseInt(e.target.value);
    if (value > 0) {
        window.api.setMaxItems(value);
    }
});

// Shortcut Input Handlers
setupShortcutInput(shortcutInput, (s) => window.api.setShortcut(s));
setupShortcutInput(imageShortcutInput, (s) => window.api.setImageShortcut(s));

// Clear History
clearBtn.addEventListener('click', () => {
    if (confirm('Tüm geçmişi silmek istediğinizden emin misiniz?')) {
        window.api.clearHistory();
    }
});

// Render List
function renderHistory(history) {
    listElement.innerHTML = '';

    if (history.length === 0) {
        listElement.innerHTML = '<div class="empty-state">Henüz kopyalanan öge yok.</div>';
        return;
    }

    history.forEach(item => {
        const itemContent = typeof item === 'string' ? item : item.content;
        const domItem = document.createElement('div');
        domItem.className = 'history-item';

        // Text part
        const textSpan = document.createElement('span');
        textSpan.className = 'history-text';
        textSpan.textContent = itemContent;

        // Icon part
        const iconSpan = document.createElement('span');
        iconSpan.className = 'copy-icon-btn';
        iconSpan.textContent = '📋';
        iconSpan.title = 'Kopyala';

        domItem.appendChild(textSpan);
        domItem.appendChild(iconSpan);

        // Click handler for the whole row
        domItem.addEventListener('click', () => {
            // Animate copy feedback
            domItem.style.borderColor = 'var(--accent)';
            iconSpan.textContent = '✅';
            setTimeout(() => {
                domItem.style.borderColor = 'transparent';
                iconSpan.textContent = '📋';
            }, 800);
            window.api.copyItem(itemContent);
        });

        listElement.appendChild(domItem);
    });
}

// Initial Load
(async () => {
    const history = await window.api.getHistory();
    const settings = await window.api.getSettings();

    maxItemsInput.value = settings.maxItems;
    if (settings.globalShortcut) {
        shortcutInput.value = settings.globalShortcut;
    }
    if (settings.globalShortcutImage) {
        imageShortcutInput.value = settings.globalShortcutImage;
    }
    renderHistory(history);
})();

// Listen for updates
window.api.onUpdateHistory((history) => {
    renderHistory(history);
});

// Toast Notification
const toastElement = document.getElementById('toast');
let toastTimeout;

function showToast(message, type = 'info') {
    toastElement.textContent = message;
    toastElement.className = `toast visible ${type}`;

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toastElement.className = 'toast hidden';
    }, 3000);
}

window.api.onShowToast((message, type) => {
    showToast(message, type);
});

// Close window on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        window.api.closeWindow();
    }
});
