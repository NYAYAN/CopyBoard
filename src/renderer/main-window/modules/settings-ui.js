// Settings panel behaviour: disclosure state, and the search that cuts across it.
//
// The old panel collapsed every group on every visit, on the reasoning that six shortcut
// rows would otherwise bury everything else. That solved the length problem by making the
// panel forget what you were doing — come back to adjust the widget's opacity and you
// reopen the same group every time. Sections are remembered instead, and the length
// problem is solved by search: type "kısayol" or "opac" and only matching rows remain,
// with their sections opened for you.

import { elements } from './dom.js';
import { closeColorPopover } from './color-picker.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
// Same folding the history search uses, so "kisayol" finds "Kısayollar" and "goruntu"
// finds "Görünüm" — see CopyBoardShared.fold.
const fold = (s) => window.CopyBoardShared.fold(s);

const STORE_KEY = 'settingsOpenSections';
// Nothing is open on a first visit: the panel's whole point is that it opens as a short
// list of headings you can take in at once, and one section already unfolded undercuts
// that before the user has asked for anything.
//
// This did default to ['appearance'], on the grounds that it holds the language picker —
// the one setting someone may need before they can read the other headings. That cost is
// one click, and the search box above covers it in the case that actually matters.
const DEFAULT_OPEN = [];

const bodyOf = (head) => document.getElementById(head.getAttribute('aria-controls'));
const cardOf = (head) => head.closest('.card');
const heads = () => Array.from(elements.settingsPanel.querySelectorAll('.card-head'));

function readOpen() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) return new Set(JSON.parse(raw));
    } catch (e) { /* first run, or storage unavailable */ }
    return new Set(DEFAULT_OPEN);
}

function writeOpen(set) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...set])); } catch (e) { /* non-fatal */ }
}

let open = readOpen();

// `persist: false` is for the search filter, which opens sections to reveal hits — that
// is a temporary state and must not overwrite what the user actually chose.
function setOpen(head, isOpen, persist = true) {
    const body = bodyOf(head);
    if (!body) return;
    body.hidden = !isOpen;
    head.setAttribute('aria-expanded', String(isOpen));
    if (!persist) return;
    const name = cardOf(head).dataset.section;
    isOpen ? open.add(name) : open.delete(name);
    writeOpen(open);
}

function applySaved() {
    heads().forEach(head => setOpen(head, open.has(cardOf(head).dataset.section), false));
    syncWidgetSection();
}

// The widget's settings only exist while the widget is switched on, so its disclosure is
// disabled rather than opening onto an empty box.
export function syncWidgetSection() {
    const on = elements.widgetCheck.checked;
    elements.widgetToggle.disabled = !on;
    elements.widgetToggle.title = on ? '' : t('Ayarları yüzen araç açıkken görünür');
    if (!on) setOpen(elements.widgetToggle, false, false);
}

// Turning the widget on should reveal what you can now change.
export function revealWidgetSection(isOn) {
    syncWidgetSection();
    if (isOn) setOpen(elements.widgetToggle, true);
}

function clearFilter() {
    const panel = elements.settingsPanel;
    panel.querySelectorAll('.card, .set-row, .set-note, .danger-zone')
        .forEach(el => { el.hidden = false; });
    elements.settingsNoMatch.hidden = true;
    applySaved();
}

function applyFilter(raw) {
    const q = fold(raw.trim());
    if (!q) { clearFilter(); return; }

    let any = false;
    elements.settingsPanel.querySelectorAll('.card').forEach(card => {
        const head = card.querySelector('.card-head');
        const heading = fold(head.textContent.trim());
        // A section whose NAME matches shows whole: searching "kısayollar" should not then
        // require a second guess at what the rows inside are called.
        const headingHit = heading.includes(q);

        let hits = 0;
        card.querySelectorAll('.set-row').forEach(row => {
            const hit = headingHit || fold(row.textContent).includes(q);
            row.hidden = !hit;
            if (hit) hits++;
        });
        card.querySelectorAll('.set-note').forEach(note => { note.hidden = !headingHit; });

        card.hidden = hits === 0;
        if (hits) {
            any = true;
            // Disabled sections (the widget while it is off) still can't be opened.
            if (!head.disabled) setOpen(head, true, false);
        }
    });

    const danger = elements.settingsPanel.querySelector('.danger-zone');
    if (danger) {
        danger.hidden = !fold(danger.textContent).includes(q);
        if (!danger.hidden) any = true;
    }

    elements.settingsNoMatch.hidden = any;
}

export function initSettingsUI() {
    heads().forEach(head => {
        head.addEventListener('click', () => setOpen(head, bodyOf(head).hidden));
    });
    applySaved();

    elements.settingsSearch.addEventListener('input', (e) => applyFilter(e.target.value));
}

// Called whenever the panel is opened: land on the remembered state with an empty search
// box, not on whatever the last visit's filter happened to leave behind.
export function onSettingsShown() {
    elements.settingsSearch.value = '';
    closeColorPopover();
    clearFilter();
}
