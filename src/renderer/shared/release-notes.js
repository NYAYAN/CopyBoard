// Release notes: Markdown → safe HTML, shared by the update dialog and the "All release
// notes" window.
//
// The notes come off the network (latest.json), so they are untrusted: text is escaped
// first, the result is parsed and REBUILT from a whitelist (only an http(s)/mailto href
// survives as an attribute), and nothing from the notes is ever assigned as live HTML.
//
// A plain classic script, like render-utils.js: it loads before the page's own script and
// leaves `CopyBoardNotes` on the global. The pure functions (Markdown, version compare)
// never touch the DOM — test/release-notes.test.mjs runs them under Node.
//
// No regex lookbehind or other recent syntax: macOS 12.3 is the minimum and its WebKit
// rejects the whole script on a single unknown construct.
(function (root) {
    'use strict';

    /** "v3.2.1" / "3.2.1" → [3, 2, 1]; an unreadable part counts as 0. */
    function parseVersion(v) {
        const parts = String(v || '').trim().replace(/^v/i, '').split(/[.+-]/);
        return [0, 1, 2].map((i) => parseInt(parts[i], 10) || 0);
    }

    function compareVersions(a, b) {
        const x = parseVersion(a);
        const y = parseVersion(b);
        for (let i = 0; i < 3; i++) {
            if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
        }
        return 0;
    }

    /** Entries newer than the installed version. The changelog is newest first. */
    function newerThan(changelog, current) {
        return (Array.isArray(changelog) ? changelog : []).filter(
            (e) => e && compareVersions(e.version, current) > 0
        );
    }

    const esc = (s) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function inline(s) {
        return esc(s)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    }

    // "**Title.** Description" → the title on its own line, the description under it
    // (CSS: `li > strong:first-child` + span). The sanitizer drops class attributes, so
    // the structure itself carries the layout. A title is not a sentence: a single
    // trailing full stop goes; an ellipsis stays.
    function renderItem(raw) {
        const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(raw);
        if (!m) return '<li>' + inline(raw) + '</li>';
        let title = m[1];
        if (title.endsWith('.') && !title.endsWith('..')) title = title.slice(0, -1);
        const rest = m[2].trim();
        return '<li><strong>' + inline(title) + '</strong>' + (rest ? '<span>' + inline(rest) + '</span>' : '') + '</li>';
    }

    const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

    // Minimal Markdown → HTML: headings, bullet and numbered lists, paragraphs, pipe
    // tables, rules, bold, italics, inline code and links.
    //
    // CHANGELOG.md is hard-wrapped at ~88 columns and a list item's continuation lines are
    // indented. They used to close the list and start a paragraph, and paragraph lines were
    // joined with <br>: the user saw a bullet cut in half and sentences broken mid-line.
    // Now a continuation line belongs to the item and a line break inside a paragraph is a
    // space (a "soft" break, as in Markdown).
    function markdownToHtml(md) {
        const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let list = null; // 'ul' | 'ol' while inside a list
        let items = [];
        let para = [];
        const flushPara = () => {
            if (para.length) {
                out.push('<p>' + inline(para.join(' ')) + '</p>');
                para = [];
            }
        };
        const closeList = () => {
            if (!list) return;
            out.push('<' + list + '>' + items.map(renderItem).join('') + '</' + list + '>');
            list = null;
            items = [];
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\s+$/, '');
            let m;
            if (!line.trim()) {
                flushPara();
                closeList();
            } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
                flushPara();
                closeList();
                const lvl = Math.min(m[1].length + 2, 6); // # → h3: the windows are small
                out.push('<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>');
            } else if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
                flushPara();
                closeList();
                const head = cells(line);
                i += 1; // the separator row
                const rows = [];
                while (i + 1 < lines.length && isTableRow(lines[i + 1])) rows.push(cells(lines[++i]));
                out.push(
                    '<table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead>' +
                    '<tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
                    '</tbody></table>'
                );
            } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
                flushPara();
                closeList();
                out.push('<hr>');
            } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
                flushPara();
                if (list !== 'ul') { closeList(); list = 'ul'; }
                items.push(m[1].trim());
            } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
                flushPara();
                if (list !== 'ol') { closeList(); list = 'ol'; }
                items.push(m[1].trim());
            } else if (list && items.length) {
                items[items.length - 1] += ' ' + line.trim();
            } else {
                para.push(line.trim());
            }
        }
        flushPara();
        closeList();
        return out.join('');
    }

    // ── DOM side (browser only) ──────────────────────────────────────────────

    const ALLOWED = new Set([
        'P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE',
        'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'BLOCKQUOTE', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN',
    ]);

    function sanitize(src, dst) {
        src.childNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                dst.appendChild(document.createTextNode(node.nodeValue));
            } else if (node.nodeType === Node.ELEMENT_NODE && ALLOWED.has(node.tagName)) {
                const el = document.createElement(node.tagName);
                if (node.tagName === 'A') {
                    const href = node.getAttribute('href') || '';
                    if (/^(https?:|mailto:)/i.test(href)) el.setAttribute('href', href);
                }
                sanitize(node, el);
                dst.appendChild(el);
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                sanitize(node, dst); // blocked tag: keep its sanitized contents
            }
        });
    }

    // electron-updater hands over HTML (the releases Atom feed); Tauri's latest.json
    // carries Markdown. Only notes that START with a block tag are treated as HTML — a
    // Markdown note that merely mentions `<details>` in backticks stays Markdown.
    const looksLikeHtml = (s) => /^\s*<(p|ul|ol|h[1-6]|div|li|table|blockquote|pre|br)\b/i.test(s);

    // A heading's leading emoji becomes a monochrome icon that follows the theme (CSS,
    // `h4[data-kind]::before`): emoji render in full colour and clash with the accent.
    const EMOJI_LEAD = /^[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍\s]+/u;

    function headingKind(text) {
        const s = String(text).toLocaleLowerCase('tr');
        if (/düzelt|hata/.test(s)) return 'fix';
        if (/yeni|özellik|eklen/.test(s)) return 'new';
        if (/güvenlik|izin|imza/.test(s)) return 'security';
        if (/iyileştir|performans|hız|geliştir|ölçül/.test(s)) return 'improve';
        if (/uyarı|önemli|dikkat|elle|kırıcı|bilinen/.test(s)) return 'warn';
        return 'note';
    }

    function decorateHeadings(container) {
        container.querySelectorAll('h3, h4, h5, h6').forEach((h) => {
            const first = h.firstChild;
            if (first && first.nodeType === Node.TEXT_NODE) {
                first.nodeValue = first.nodeValue.replace(EMOJI_LEAD, '');
            }
            h.dataset.kind = headingKind(h.textContent || '');
        });
    }

    /** Renders `notes` into `container`, replacing its contents. */
    function renderInto(container, notes, emptyText) {
        container.textContent = '';
        const text = String(notes || '');
        if (!text.trim()) {
            container.textContent = emptyText || '';
            return;
        }
        try {
            const html = looksLikeHtml(text) ? text : markdownToHtml(text);
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            const frag = document.createDocumentFragment();
            sanitize(parsed.body, frag);
            container.appendChild(frag);
            decorateHeadings(container);
        } catch (e) {
            container.textContent = text; // inert plain-text fallback
        }
    }

    // Links open in the browser, never inside the webview.
    function interceptLinks(container, open) {
        container.addEventListener('click', (e) => {
            const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a) return;
            e.preventDefault();
            if (open) open(a.getAttribute('href'));
        });
    }

    root.CopyBoardNotes = {
        parseVersion, compareVersions, newerThan, markdownToHtml, headingKind, renderInto, interceptLinks,
    };
})(typeof window !== 'undefined' ? window : globalThis);
