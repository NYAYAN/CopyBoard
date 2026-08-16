// In-window colour picker for the floating widget's colour.
//
// It replaces <input type="color">, which could not work here: this window hides itself
// the moment it loses focus (see the 'blur' handler in window-manager.js), and opening the
// OS colour panel is exactly that — so clicking the swatch dismissed the settings you were
// in the middle of and left a native panel pointing at a hidden window. Nothing about the
// IPC was broken; the picker simply took the window away with it.
//
// Everything here lives inside the page, so focus never leaves: a row of presets for the
// quick answer, a hue slider for anything else, and a hex field for an exact value.

import { elements } from './dom.js';

const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);

// Enough spread to cover "make it match my desktop" without becoming a paint chart.
const PRESETS = [
    '#8957e5', '#6366f1', '#0ea5e9', '#06b6d4',
    '#10b981', '#84cc16', '#eab308', '#f97316',
    '#ef4444', '#ec4899', '#a855f7', '#64748b'
];

const HEX_RE = /^[0-9a-f]{6}$/i;

let onPick = () => { };
let current = PRESETS[0];

// The slider walks hue at a fixed saturation/lightness — a single row of colour, which is
// what this setting actually is. Full HSV would need a 2D field and a lot more chrome.
const SAT = 0.62;
const LIGHT = 0.58;

function hslToHex(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
        return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToHue(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return Math.round(((h * 60) + 360) % 360);
}

function paint(hex, { hue = true, hexField = true } = {}) {
    current = hex;
    elements.widgetColorDot.style.background = hex;
    elements.cpSwatches.querySelectorAll('.cp-swatch').forEach(b => {
        b.classList.toggle('active', b.dataset.color.toLowerCase() === hex.toLowerCase());
    });
    // Skip the control the user is currently driving, or dragging the slider fights the
    // value it just produced (and the hex field re-writes itself under the caret).
    if (hue) elements.cpHue.value = String(hexToHue(hex));
    if (hexField) elements.cpHex.value = hex.slice(1).toUpperCase();
}

function apply(hex, opts) {
    paint(hex, opts);
    onPick(hex);
}

export function isColorPopoverOpen() {
    return !elements.colorPopover.hidden;
}

export function closeColorPopover() {
    if (elements.colorPopover.hidden) return;
    elements.colorPopover.hidden = true;
    elements.widgetColorBtn.setAttribute('aria-expanded', 'false');
}

function openPopover() {
    elements.colorPopover.hidden = false;
    elements.widgetColorBtn.setAttribute('aria-expanded', 'true');
    // Bring it into view: the popover hangs below the row and the settings panel scrolls.
    elements.colorPopover.scrollIntoView({ block: 'nearest' });
}

// `initial` is the stored colour; `onChange` gets every new value (live, as the slider
// moves) so the widget updates while you choose rather than after.
export function initColorPicker(initial, onChange) {
    onPick = onChange || (() => { });

    const frag = document.createDocumentFragment();
    PRESETS.forEach((hex) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cp-swatch';
        b.dataset.color = hex;
        b.style.background = hex; // CSSOM: this window's CSP has no 'unsafe-inline'
        b.setAttribute('aria-label', hex);
        b.addEventListener('click', () => apply(hex));
        frag.appendChild(b);
    });
    elements.cpSwatches.appendChild(frag);

    elements.widgetColorBtn.addEventListener('click', () => {
        isColorPopoverOpen() ? closeColorPopover() : openPopover();
    });

    elements.cpHue.addEventListener('input', (e) => {
        apply(hslToHex(Number(e.target.value), SAT, LIGHT), { hue: false });
    });

    // Applied only once it is a whole colour, so typing the first digit doesn't repaint
    // the widget with a colour nobody asked for.
    elements.cpHex.addEventListener('input', (e) => {
        const raw = e.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 6);
        if (raw !== e.target.value) e.target.value = raw;
        if (HEX_RE.test(raw)) apply(`#${raw.toLowerCase()}`, { hexField: false });
    });

    // Leaving the field with a half-typed value should show what is actually in effect.
    elements.cpHex.addEventListener('blur', () => paint(current));

    // Click-away and Escape. Capture phase so a click on the button itself still reaches
    // its own toggle handler first.
    document.addEventListener('mousedown', (e) => {
        if (!isColorPopoverOpen()) return;
        if (e.target.closest('#color-popover, #widget-color-btn')) return;
        closeColorPopover();
    });

    elements.widgetColorBtn.title = t('Renk seç');
    paint(HEX_RE.test((initial || '').slice(1)) ? initial : PRESETS[0]);
}

// Reflect a value that changed elsewhere (startup, or a reset) without echoing it back.
export function setColorPickerValue(hex) {
    if (hex && HEX_RE.test(hex.slice(1))) paint(hex);
}
