// In-page labels for the capture overlays' toolbars.
//
// Native `title` tooltips are drawn by the OS in their own window at the normal window
// level. The snipper and the recorder cover the screen and sit always-on-top, so those
// tooltips are painted BEHIND them and are never seen — which left two bars of icon-only
// buttons with no readable labels at all. This draws the label inside the page instead.
//
// A PLAIN classic script (like render-utils.js and content-type.js): neither overlay is
// built from modules, and both need exactly this.
//
// init() must run AFTER shared/i18n.js has translated the markup — the label is read off
// the title attribute, and reading it earlier would freeze the Turkish string into an
// English UI. Calling it from DOMContentLoaded does that, because i18n.js registers its
// own listener first.
(function () {
    const DELAY_MS = 250;

    let tip = null;
    let timer = null;

    function element() {
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'tool-tip';
            document.body.appendChild(tip);
        }
        return tip;
    }

    function hide() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (tip) tip.classList.remove('visible');
    }

    function show(el) {
        const node = element();
        node.textContent = el.dataset.tip;
        node.classList.add('visible');

        const r = el.getBoundingClientRect();
        const w = node.offsetWidth;
        const h = node.offsetHeight;
        const left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6));
        // Above the button by default — these toolbars sit low on the screen, so there is
        // room up there and often none below. Flips when it would go off-screen.
        const above = r.top - h - 8;
        node.style.left = left + 'px';
        node.style.top = (above < 6 ? r.bottom + 8 : above) + 'px';
    }

    function wire(root) {
        (root || document).querySelectorAll('[title]').forEach((el) => {
            el.dataset.tip = el.getAttribute('title');
            el.removeAttribute('title'); // stop the invisible native one from ever showing
            el.addEventListener('mouseenter', () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => show(el), DELAY_MS);
            });
            el.addEventListener('mouseleave', hide);
            el.addEventListener('click', hide);
        });
    }

    window.CopyBoardOverlayTooltip = {
        // `selector` scopes it to the toolbar so a stray title elsewhere isn't converted.
        init(selector) {
            const run = () => document.querySelectorAll(selector).forEach(wire);
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
            else run();
        },
        hide
    };
})();
