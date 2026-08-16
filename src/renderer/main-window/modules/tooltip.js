// One in-page tooltip for the whole window.
//
// Native `title` tooltips are drawn by the OS in their own window at the normal window
// level. This window is always-on-top, so those tooltips render BEHIND it and are simply
// never seen — every title= in here was dead weight. This draws the tooltip inside the
// page instead, so it's always visible and can't be occluded.
//
// Elements are converted lazily on first hover (title → data-tip), which also covers rows
// and buttons that are created after load.

const DEFAULT_DELAY = 400;
const MARGIN = 8;

let tipEl = null;
let timer = null;

function element() {
    if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.className = 'app-tooltip';
        document.body.appendChild(tipEl);
    }
    return tipEl;
}

export function hideTooltip() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (tipEl) tipEl.classList.remove('visible');
}

// Show `text` anchored to `rect` (a DOMRect-like) after `delay` ms.
export function showTooltipAt(text, rect, delay = DEFAULT_DELAY) {
    if (timer) clearTimeout(timer);
    if (!text) return;
    timer = setTimeout(() => {
        timer = null;
        const el = element();
        el.textContent = text;
        // Make it measurable before deciding which side it goes on.
        el.style.left = '0px';
        el.style.top = '0px';
        el.classList.add('visible');

        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let left = rect.left;
        if (left + w > window.innerWidth - MARGIN) left = window.innerWidth - w - MARGIN;
        if (left < MARGIN) left = MARGIN;

        const below = rect.bottom + MARGIN;
        const top = below + h > window.innerHeight - MARGIN
            ? Math.max(MARGIN, rect.top - h - MARGIN) // flip above when there's no room
            : below;

        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }, delay);
}

export function initTooltips() {
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest && e.target.closest('[title], [data-tip]');
        // History rows drive their own (longer, slower) tooltip — see history-renderer.
        if (!el || el.closest('.row')) return;

        if (el.hasAttribute('title')) {
            const t = el.getAttribute('title');
            el.removeAttribute('title'); // stop the invisible native one from ever showing
            if (t) el.dataset.tip = t;
        }
        showTooltipAt(el.dataset.tip, el.getBoundingClientRect());
    });

    document.addEventListener('mouseout', (e) => {
        const el = e.target.closest && e.target.closest('[data-tip]');
        if (el) hideTooltip();
    });

    // Any interaction or scroll should drop it immediately.
    document.addEventListener('mousedown', hideTooltip, true);
    document.addEventListener('scroll', hideTooltip, { capture: true, passive: true });
    window.addEventListener('blur', hideTooltip);
}
