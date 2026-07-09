const listEl = document.getElementById('qp-list');
const closeBtn = document.getElementById('qp-close');

// How many recent history items to show. The main process sends the configured
// value with every 'quickpaste-show'; 20 is just the pre-config default.
let count = 20;

// Auto-dismiss: the picker window is focusable:false, so it never receives a
// 'blur' — we can't rely on the OS to close it. Instead we close it a short beat
// after the cursor leaves, and as a fallback if it's opened but never touched.
const IDLE_MS = 4000;   // shown but no interaction at all
const LEAVE_MS = 1800;  // cursor left the panel
let idleTimer = null;
let leaveTimer = null;

function clearTimers() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
}

function armIdle() {
    clearTimers();
    idleTimer = setTimeout(() => window.api.quickPasteDismiss(), IDLE_MS);
}

function render(history) {
    const items = (history || []).slice(0, count);
    listEl.innerHTML = '';

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'qp-empty';
        empty.textContent = 'Geçmiş boş';
        listEl.appendChild(empty);
        return;
    }

    for (const item of items) {
        const div = document.createElement('div');
        div.className = 'qp-item';
        div.textContent = item.content;
        div.title = item.content;
        div.addEventListener('click', () => {
            window.api.quickPastePick(item.content);
        });
        listEl.appendChild(div);
    }
}

async function reload() {
    const data = await window.api.getHistory();
    render((data && data.history) || []);
    listEl.scrollTop = 0;
}

// Initial population (first time the window loads).
reload();

// Re-populate + reset scroll/timers every time the picker is (re)shown.
window.api.onQuickPasteShow((data) => {
    if (data && data.count) count = data.count;
    reload();
    armIdle();
});

// Keep in sync if the clipboard changes while the picker is open.
window.api.onUpdateHistory((data) => {
    render((data && data.history) || []);
});

// Stay open while hovered; dismiss shortly after the cursor leaves the window.
document.documentElement.addEventListener('mouseenter', clearTimers);
document.documentElement.addEventListener('mouseleave', () => {
    clearTimers();
    leaveTimer = setTimeout(() => window.api.quickPasteDismiss(), LEAVE_MS);
});

// Explicit close (X button). Esc is handled in the main process via a global
// accelerator, since this window is focusable:false and never sees a keydown.
closeBtn.addEventListener('click', () => window.api.quickPasteDismiss());
