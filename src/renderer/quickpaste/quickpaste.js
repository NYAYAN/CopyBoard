const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
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

// Shared hover tooltip: one element, content built only after the cursor rests on a
// row for 500ms. Rows are single-line ellipsized; this shows the fuller content.
const TOOLTIP_CHARS = 500;
const TOOLTIP_DELAY_MS = 500;
const tip = document.createElement('div');
tip.className = 'qp-tooltip';
document.body.appendChild(tip);
let tipTimer = null;

function hideTip() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    tip.classList.remove('visible');
}

function scheduleTip(content, row) {
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
        tipTimer = null;
        tip.textContent = content.length > TOOLTIP_CHARS ? content.slice(0, TOOLTIP_CHARS) + '…' : content;
        const r = row.getBoundingClientRect();
        tip.style.left = '8px';
        tip.style.top = '0px';
        tip.classList.add('visible');
        const th = tip.offsetHeight;
        const below = r.bottom + 6;
        tip.style.top = (below + th > window.innerHeight - 8 ? Math.max(8, r.top - th - 6) : below) + 'px';
    }, TOOLTIP_DELAY_MS);
}

listEl.addEventListener('scroll', hideTip, { passive: true });

function render(history) {
    hideTip(); // rows are about to be torn down
    const items = (history || []).slice(0, count);
    listEl.innerHTML = '';

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'qp-empty';
        empty.textContent = t('Geçmiş boş');
        listEl.appendChild(empty);
        return;
    }

    // Rows clip what goes into the DOM (a copied item can be hundreds of KB); the click
    // handler passes the full item.content, so what gets pasted is never truncated.
    const PREVIEW_CHARS = 220; // single-line rows — this covers any realistic width
    const C = window.CopyBoardContent;

    for (const item of items) {
        const div = document.createElement('div');
        div.className = 'qp-item';

        // Same leading glyph as the main list — a picker you are scanning under time
        // pressure benefits from it more than the list does, not less.
        const type = C.classify(item.content);
        const icon = document.createElement('span');
        icon.className = 'qp-icon';
        const colour = type === 'color' ? C.cssColor(item.content) : null;
        if (colour) {
            const swatch = document.createElement('span');
            swatch.className = 'qp-swatch';
            // Through the CSSOM: this window's CSP has no 'unsafe-inline' for styles.
            swatch.style.background = colour;
            icon.appendChild(swatch);
        } else {
            icon.innerHTML = C.iconFor(type);
        }

        const text = document.createElement('span');
        text.className = C.MONO_TYPES.has(type) ? 'qp-text mono' : 'qp-text';
        text.textContent = C.previewText(item.content, PREVIEW_CHARS);

        div.appendChild(icon);
        div.appendChild(text);
        div.addEventListener('mouseenter', () => scheduleTip(item.content, div));
        div.addEventListener('mouseleave', hideTip);
        div.addEventListener('click', () => {
            hideTip();
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
