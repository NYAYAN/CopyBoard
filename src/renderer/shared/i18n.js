// Interface language, renderer side. A PLAIN classic script (like render-utils.js): it
// loads before every page's own script, translates the static markup in one pass, and
// leaves t() on a global for code that builds strings at runtime.
//
// Turkish is the source language and every Turkish string is its own key, so the markup
// needs no data-i18n attributes: this walks the document and swaps whatever it finds in
// the dictionary. Anything missing stays Turkish.
//
// The walk runs ONCE, at load, while the page still holds only its own chrome. It must
// never run over rendered clipboard content — a history row whose text happened to match
// a key ("Kaydet") would be silently rewritten. Runtime strings go through t() instead.
(function () {
    const bridge = (window.api && window.api.i18n) || { lang: 'tr', dict: {} };
    const dict = bridge.dict || {};

    function fill(template, vars) {
        if (!vars) return template;
        return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
    }

    function t(turkish, vars) {
        return fill(dict[turkish] || turkish, vars);
    }

    const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);

    function translateDocument() {
        document.documentElement.lang = bridge.lang;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => (SKIP_TAGS.has(node.parentNode.tagName) ? NodeFilter.FILTER_REJECT
                : node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
        });
        const texts = [];
        while (walker.nextNode()) texts.push(walker.currentNode);
        for (const node of texts) {
            const hit = dict[node.nodeValue.trim()];
            // Keep the original padding: these sit inside formatted markup.
            if (hit) node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), hit);
        }

        for (const attr of ATTRS) {
            for (const el of document.querySelectorAll('[' + attr + ']')) {
                const hit = dict[el.getAttribute(attr).trim()];
                if (hit) el.setAttribute(attr, hit);
            }
        }
    }

    window.CopyBoardI18n = { t, lang: bridge.lang };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', translateDocument);
    } else {
        translateDocument();
    }
})();
