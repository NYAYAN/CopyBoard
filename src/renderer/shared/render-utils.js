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
window.CopyBoardShared = {
    // Monochrome inline SVGs (stroke=currentColor) for the shared row actions, so they
    // render consistently across OSes and don't reflow on state swaps (fixed viewBox).
    ICONS: {
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        starFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
        starOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    },

    // List search predicate: an item matches when the (lowercased) query is a substring
    // of its content OR its note. `query` must already be lowercased by the caller — this
    // mirrors the previous inline logic exactly (callers lowercased once, before filtering).
    matchesSearch(item, query) {
        const contentMatch = item.content && item.content.toLowerCase().includes(query);
        const noteMatch = item.note && item.note.toLowerCase().includes(query);
        return contentMatch || noteMatch;
    }
};
