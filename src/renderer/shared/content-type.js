// What KIND of thing a clipboard entry is, and how a row should say so.
//
// A list where a URL, a password, a hex colour and a paragraph of prose all render as the
// same grey sentence makes finding the right one a reading task rather than a scanning
// one. Classifying the content buys a leading glyph (and, for a colour, the colour
// itself), a monospace face where the content is structured, and a timestamp carrying only
// the part the day heading hasn't already said.
//
// A PLAIN classic script, like render-utils.js: three windows show rows of clipboard
// entries — the main list, the widget's panel and the quick-paste picker — and only one of
// them is an ES module. It attaches to a namespaced global; main-window/modules/
// content-type.js re-exports it so module code can import normally.
//
// Classification is display-only. Nothing here ever touches what gets copied — that is
// always the untouched item.content.
(function () {
    const RE = {
        // #rgb / #rrggbb / #rrggbbaa, plus the functional notations.
        hex: /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
        fn: /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%,\s/deg]+\)$/i,
        url: /^(?:https?:\/\/|file:\/\/|ftp:\/\/|www\.)[^\s]+$/i,
        email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i,
        // /usr/local, ~/Documents/x, ./src/a.js, C:\Users\… — a separator is required, so
        // a bare sentence with a slash in it doesn't qualify.
        path: /^(?:~|\.{1,2})?\/[^\s]*$|^[a-z]:\\[^\s]*$/i,
        file: /^[\w.\-()\u00c0-\u024f]+\.[a-z0-9]{1,8}$/i,
        // Deliberately conservative: a fragment only counts as code when it carries syntax
        // prose does not. Prose with a semicolon in it shouldn't turn into a code row.
        code: /[{};]|=>|<\/\w|^\s*(?:const|let|var|function|class|import|export|def|SELECT|INSERT|UPDATE)\b/m
    };

    function classify(content) {
        if (!content) return 'text';
        const s = content.trim();
        if (!s) return 'text';

        const singleLine = !/[\r\n]/.test(s);

        if (singleLine) {
            if (s.length <= 32 && (RE.hex.test(s) || RE.fn.test(s))) return 'color';
            if (s.length <= 2048) {
                if (RE.url.test(s)) return 'url';
                if (RE.email.test(s)) return 'email';
                if (RE.path.test(s)) return 'path';
                if (RE.file.test(s)) return 'file';
            }
        }

        // Only test the head: RE.code is a scan, and an entry can be a megabyte.
        if (RE.code.test(s.slice(0, 400))) return 'code';
        return singleLine ? 'text' : 'block';
    }

    // A colour row paints its own swatch, so the value has to be usable as a CSS colour.
    // Anything the browser rejects falls back to a plain row rather than a blank chip.
    function cssColor(content) {
        const s = (content || '').trim();
        return CSS.supports('color', s) ? s : null;
    }

    // Structured content is read character by character, not word by word.
    const MONO_TYPES = new Set(['color', 'path', 'file', 'code']);

    const ICONS = {
        url: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
        email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="m2.5 7 8.4 5.6a2 2 0 0 0 2.2 0L21.5 7"/></svg>',
        path: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
        code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 17-5-5 5-5M16 7l5 5-5 5"/></svg>',
        block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 11h16M4 16h10"/></svg>',
        text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7V5h14v2M12 5v14M9.5 19h5"/></svg>'
    };

    const iconFor = (type) => ICONS[type] || ICONS.text;

    // Row text: newlines and runs of whitespace collapse to single spaces, so a snippet
    // that begins with two blank lines doesn't render as an empty row. The clip happens
    // first — an entry can be a megabyte and the regex would otherwise walk all of it.
    function previewText(content, max) {
        const s = content || '';
        const head = s.length > max * 2 ? s.slice(0, max * 2) : s;
        const flat = head.replace(/\s+/g, ' ').trim();
        return flat.length > max ? flat.slice(0, max) + '…' : flat;
    }

    // Tooltip text: the row is one line by necessity, the tooltip is not, and it is drawn
    // with white-space:pre-wrap — so this keeps the line breaks that make a code snippet
    // or an address block readable.
    function clip(content, max) {
        const s = (content || '').trim();
        return s.length > max ? s.slice(0, max) + '…' : s;
    }

    // ── Time ─────────────────────────────────────────────────────────────────────
    const locale = () => ((window.CopyBoardI18n && window.CopyBoardI18n.lang) === 'en' ? 'en-GB' : 'tr-TR');

    // Built once. Constructing an Intl.DateTimeFormat per item per render was measurable
    // on a 500-item list, and the list re-renders on every keystroke in the search box.
    let fmt = null;
    function formats() {
        if (!fmt) {
            const l = locale();
            fmt = {
                time: new Intl.DateTimeFormat(l, { hour: '2-digit', minute: '2-digit' }),
                weekday: new Intl.DateTimeFormat(l, { weekday: 'short' }),
                dayMonth: new Intl.DateTimeFormat(l, { day: '2-digit', month: '2-digit' }),
                full: new Intl.DateTimeFormat(l, { day: '2-digit', month: '2-digit', year: 'numeric' }),
                fullTime: new Intl.DateTimeFormat(l, {
                    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
                })
            };
        }
        return fmt;
    }

    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

    // 'today' | 'yesterday' | 'week' | 'older' — the day heading a row belongs under.
    function groupKey(date, now) {
        const ref = now || new Date();
        const days = Math.round((startOfDay(ref) - startOfDay(date)) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 7) return 'week';
        return 'older';
    }

    const GROUP_LABELS = {
        today: 'Bugün',
        yesterday: 'Dün',
        week: 'Bu hafta',
        older: 'Daha eski'
    };

    // Only the part the heading above the row hasn't already said.
    function shortTime(date, key, now) {
        const ref = now || new Date();
        const f = formats();
        if (key === 'today' || key === 'yesterday') return f.time.format(date);
        if (key === 'week') return f.weekday.format(date);
        return date.getFullYear() === ref.getFullYear() ? f.dayMonth.format(date) : f.full.format(date);
    }

    // The whole stamp, for the hover tooltip — the row only ever shows the short form.
    const fullTime = (date) => formats().fullTime.format(date);

    window.CopyBoardContent = {
        classify, cssColor, MONO_TYPES, iconFor, previewText, clip,
        groupKey, GROUP_LABELS, shortTime, fullTime
    };
})();
