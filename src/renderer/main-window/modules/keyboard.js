// Keyboard navigation for the history list.
//
// Before this the window handled exactly one key — Escape. Everything else was a mouse
// trip: open the panel, aim at a row, aim at the small button on it. For a window whose
// whole purpose is "give me the thing I copied a minute ago and get out of the way", the
// fastest path should never leave the home row.
//
// The list is the only thing that responds; a modal or a non-history view hands the
// keyboard back. Selection survives a re-render by item id, so a clipboard update landing
// mid-navigation doesn't yank the cursor to the top.

import { elements } from './dom.js';
import { confirmAction } from './modals.js';
import { previewText } from './content-type.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

const PAGE = 8;

let selectedId = null;

const rows = () => Array.from(elements.listElement.querySelectorAll('.row'));
const rowById = (id) => elements.listElement.querySelector(`.row[data-item-id="${CSS.escape(id)}"]`);

export function getSelectedRow() {
    return selectedId ? rowById(selectedId) : null;
}

function paint(row, scroll) {
    elements.listElement.querySelectorAll('.row.selected')
        .forEach(el => el.classList.remove('selected'));
    if (!row) {
        selectedId = null;
        elements.listElement.removeAttribute('aria-activedescendant');
        return;
    }
    selectedId = row.dataset.itemId;
    row.classList.add('selected');
    // The focus stays in the search box while the arrows move through the list, so the
    // listbox has to name its current option rather than move focus onto it.
    elements.listElement.setAttribute('aria-activedescendant', row.id);
    if (scroll) row.scrollIntoView({ block: 'nearest' });
}

export function selectRow(row, scroll = true) {
    paint(row, scroll);
}

function move(delta) {
    const all = rows();
    if (!all.length) return;
    const current = getSelectedRow();
    const i = current ? all.indexOf(current) : -1;
    const next = i === -1
        ? (delta > 0 ? 0 : all.length - 1)
        : Math.max(0, Math.min(all.length - 1, i + delta));
    paint(all[next], true);
}

// Restore after a re-render: keep the same item if it survived, otherwise fall back to
// the row that took its place, otherwise the first one. A list with rows always has a
// selection, so Enter is meaningful the instant the window opens.
function restore() {
    const all = rows();
    if (!all.length) { selectedId = null; return; }
    paint(rowById(selectedId) || all[0], false);
}

const clickAction = (row, act) => {
    const btn = row && row.querySelector(`.action-btn[data-act="${act}"]`);
    if (btn) btn.click();
    return !!btn;
};

// Deleting the row under the cursor should leave the cursor where the eye already is.
function advancePast(row) {
    const all = rows();
    const next = all[all.indexOf(row) + 1] || all[all.indexOf(row) - 1];
    selectedId = next ? next.dataset.itemId : null;
}

// A history entry is a copy of something that still exists somewhere, so the keystroke
// just takes it. A FAVOURITE is not: it carries a note and a hand-chosen position, and
// re-starring the same text later brings back neither. That one asks first.
function removeRow(row) {
    if (row.dataset.tabContext !== 'favorites') {
        advancePast(row);
        clickAction(row, 'delete');
        return;
    }

    const item = row.__item || {};
    const label = previewText(item.content || '', 60);
    const text = item.note
        ? t('“{label}” favorilerden çıkarılacak. Eklediğiniz not da silinecek.', { label })
        : t('“{label}” favorilerden çıkarılacak.', { label });

    confirmAction({
        title: t('Favorilerden çıkar'),
        text,
        confirmLabel: t('Çıkar')
    }).then((ok) => {
        if (!ok) return;
        // Re-resolved after the await: the list may have been rebuilt by a clipboard
        // update while the dialog was open, which would leave `row` detached.
        const current = rowById(item.id) || row;
        advancePast(current);
        clickAction(current, 'delete');
    });
}

function onKey(e) {
    // A modal owns the keyboard while it is open, and the other views have no list.
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;
    if (elements.app.dataset.view !== 'history') return;

    const el = document.activeElement;
    const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    // The search box is part of the list interaction, not an exception to it: you type to
    // filter and arrow through the results without ever leaving the field.
    const inSearch = el === elements.searchInput;
    const captive = inField && !inSearch;
    const mod = e.metaKey || e.ctrlKey;

    switch (e.key) {
        case 'ArrowDown':
            if (captive) return;
            e.preventDefault();
            move(1);
            return;
        case 'ArrowUp':
            if (captive) return;
            e.preventDefault();
            move(-1);
            return;
        case 'PageDown':
            if (captive) return;
            e.preventDefault();
            move(PAGE);
            return;
        case 'PageUp':
            if (captive) return;
            e.preventDefault();
            move(-PAGE);
            return;
        case 'Home':
        case 'End':
            // In a text field these belong to the caret.
            if (inField) return;
            e.preventDefault();
            move(e.key === 'Home' ? -1e6 : 1e6);
            return;
        case 'Enter': {
            if (captive) return;
            const row = getSelectedRow();
            if (!row) return;
            e.preventDefault();
            if (mod) {
                // Copy but stay: for collecting several items in a row without
                // re-summoning the window each time.
                const item = row.__item;
                if (!item) return;
                window.api.copyText(item.content);
                row.classList.add('copied');
                setTimeout(() => row.classList.remove('copied'), 800);
            } else {
                clickAction(row, 'copy');
            }
            return;
        }
        case 'Backspace':
        case 'Delete': {
            // Plain Backspace has to keep editing the search text.
            if (inField && !mod) return;
            const row = getSelectedRow();
            if (!row) return;
            e.preventDefault();
            removeRow(row);
            return;
        }
        default:
            break;
    }

    if (mod && (e.key === 'd' || e.key === 'D')) {
        const row = getSelectedRow();
        if (!row) return;
        e.preventDefault();
        // In the favourites tab un-starring IS removal, so it goes through the same
        // confirmation the delete key does rather than round the side of it.
        if (row.dataset.tabContext === 'favorites') removeRow(row);
        else clickAction(row, 'star');
        return;
    }

    // Type anywhere to search. Focus normally sits in the search box already, but a click
    // on a row (rows aren't focusable) drops it — without this, typing after a click goes
    // nowhere. The keystroke is replayed by hand because the field wasn't focused to
    // receive it.
    if (!inField && !mod && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        elements.searchInput.focus();
        elements.searchInput.value += e.key;
        elements.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

export function initKeyboard() {
    elements.listElement.addEventListener('list:rendered', restore);
    document.addEventListener('keydown', onKey);

    // Mouse and keyboard should agree on what "current" means: clicking a row makes it the
    // selection, so a following arrow key continues from there rather than from the top.
    elements.listElement.addEventListener('mousedown', (e) => {
        const row = e.target.closest('.row');
        if (row) paint(row, false);
    });
}

// Called when the list is replaced wholesale (tab switch, view reset): start again from
// the top rather than hunting for an id that belonged to the other list.
export function resetSelection() {
    selectedId = null;
}
