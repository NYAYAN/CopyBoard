const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>'
};

// The window is REUSED across toasts (main hides it on 'toast-finished' instead of
// destroying it), so a new toast can arrive while the previous one's timers are still
// pending. Clear them on every show or a stale timer would hide the fresh toast early.
let progressTimer = null;
let closeTimer = null;
let finishTimer = null;

// contextBridge through preload.js
window.api.onShowToast((message, type) => {
    const toast = document.getElementById('toast');
    const msg = document.getElementById('message');
    const icon = document.getElementById('icon');
    const progress = document.getElementById('progress');

    [progressTimer, closeTimer, finishTimer].forEach(t => { if (t) clearTimeout(t); });

    msg.textContent = message;
    // Normalize unknown types (e.g. 'warning' is dispatched in production) so
    // the CSS class and the icon always agree. Note: no 'show' yet — the card stays
    // parked off-screen (translateX) until the window has been resized around it.
    const t = TOAST_ICONS[type] ? type : 'info';
    toast.className = 'toast ' + t;
    icon.innerHTML = TOAST_ICONS[t];

    // Fit the OS window to the card. The window is a fixed rectangle, so a message
    // taller than it was silently CLIPPED — the end of a long warning was unreadable.
    // offsetHeight forces layout of the new text and ignores the off-screen transform;
    // CARD_MARGIN mirrors the .toast margin in toast.html.
    const CARD_MARGIN = 20;
    window.api.toastResize(toast.offsetHeight + CARD_MARGIN * 2);

    // Auto close after 3s
    progress.style.transition = 'none';
    progress.style.width = '100%';
    progressTimer = setTimeout(() => {
        progress.style.transition = 'width 3s linear';
        progress.style.width = '0%';
    }, 10);

    // Slide in on the next frame, after the resize has landed.
    requestAnimationFrame(() => toast.classList.add('show'));

    closeTimer = setTimeout(() => {
        toast.classList.remove('show');
        // notify main to hide the (reusable) toast window
        finishTimer = setTimeout(() => {
            window.api.toastFinished();
        }, 500);
    }, 3000);
});
