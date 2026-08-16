// Shared render helpers for the two independent row-list renderers
// (main-window/modules/history-renderer.js — an ES module — and widget/widget.js —
// a classic non-module script). This file is a PLAIN classic script: it must load via
// a normal <script src> tag with no import/export, so it attaches its exports to a
// namespaced global instead. ES modules can freely read window globals; the classic
// widget script reads them the same way.
//
// Only the genuinely-shared subset lives here: the 4 row-action icons that were
// byte-for-byte identical in both files, and the list search predicate. Icons unique
// to one renderer (history-renderer's check/noteAdd/noteEdit) intentionally stay local.
// Applied AFTER toLowerCase, so only the lowercase forms need an entry. U+0307 is the
// combining dot that lowercasing 'İ' leaves behind.
const FOLD = {
    '̇': '', 'ı': 'i', 'ş': 's', 'ğ': 'g', 'ç': 'c', 'ö': 'o', 'ü': 'u'
};

window.CopyBoardShared = {
    // Monochrome inline SVGs (stroke=currentColor) for the shared row actions, so they
    // render consistently across OSes and don't reflow on state swaps (fixed viewBox).
    ICONS: {
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        starFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
        starOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    },

    // Search folding. toLowerCase() alone cannot match Turkish text, and the failures are
    // not edge cases — they are the most common letters in the language:
    //
    //   'İSTANBUL'.toLowerCase()  →  'i̇stanbul'   (i + U+0307, a COMBINING DOT ABOVE)
    //                                              so "istanbul" never matched it
    //   'IŞIK'.toLowerCase()      →  'işik'        so "isik" never matched it
    //   'Güneş'                   →  'güneş'       so "gunes" never matched it
    //
    // Both sides go through this, so it is symmetric: "sarki" finds "ŞARKI" and "ŞARKI"
    // finds "sarki". Deliberately a lowercase + single regex pass rather than a full
    // NFD normalise — the list re-filters on every keystroke over items that can be
    // hundreds of KB, and this is the same order of cost as the toLowerCase() it replaces.
    //
    // Note it folds toward ASCII rather than applying Turkish casing rules: someone
    // typing "isik" on a keyboard without ı should still find "ışık", and vice versa.
    fold(s) {
        return String(s || '').toLowerCase().replace(/[̇ışğçöü]/g, (ch) => FOLD[ch]);
    },

    // List search predicate: an item matches when the folded query is a substring of its
    // folded content OR note. `query` must already be folded by the caller (once per
    // keystroke, rather than once per item).
    matchesSearch(item, query) {
        const fold = window.CopyBoardShared.fold;
        const contentMatch = item.content && fold(item.content).includes(query);
        const noteMatch = item.note && fold(item.note).includes(query);
        return contentMatch || noteMatch;
    }
};
