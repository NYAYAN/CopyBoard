const t = (s, v) => (typeof window !== 'undefined' && window.CopyBoardI18n ? window.CopyBoardI18n.t(s, v) : s);
const Notes = window.CopyBoardNotes;

// "All release notes": the version list on the left jumps to a release, the notes on
// the right scroll through every release, newest first. Opened from the update dialog;
// the data is the same latest.json the update check already fetched (its `changelog`).

const $ = (id) => document.getElementById(id);
const content = $('content');
const list = $('versionList');
let sections = [];

const sectionId = (v) => 'rel-' + String(v).replace(/[^0-9a-z]+/gi, '-');

function setActive(version) {
    list.querySelectorAll('.ver-item').forEach((b) => {
        const on = b.dataset.version === version;
        b.classList.toggle('active', on);
        if (on) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
    });
}

function render(info) {
    const current = info.currentVersion || '';
    let entries = Array.isArray(info.changelog) ? info.changelog.filter((e) => e && e.version) : [];
    // An older latest.json has no changelog: show at least the version on offer.
    if (!entries.length && info.version) entries = [{ version: info.version, notes: info.releaseNotes || '' }];
    entries = entries.slice().sort((a, b) => Notes.compareVersions(b.version, a.version));

    const newer = Notes.newerThan(entries, current).length;
    const parts = [t('Kurulu {version}', { version: current })];
    if (newer === 1) parts.push(t('1 yeni sürüm'));
    else if (newer > 1) parts.push(t('{n} yeni sürüm', { n: newer }));
    $('subtitle').textContent = parts.join(' · ');

    list.textContent = '';
    content.textContent = '';
    sections = [];

    for (const e of entries) {
        const cmp = Notes.compareVersions(e.version, current);
        const tag = cmp > 0 ? t('Yeni') : cmp === 0 ? t('Kurulu') : '';

        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ver-item';
        item.dataset.version = e.version;
        const label = document.createElement('span');
        label.textContent = e.version;
        item.appendChild(label);
        if (tag) {
            const tg = document.createElement('span');
            tg.className = 'ver-tag' + (cmp > 0 ? ' new' : '');
            tg.textContent = tag;
            item.appendChild(tg);
        }
        item.addEventListener('click', () => {
            setActive(e.version);
            $(sectionId(e.version)).scrollIntoView({ block: 'start' });
        });
        list.appendChild(item);

        const sec = document.createElement('section');
        sec.className = 'release';
        sec.id = sectionId(e.version);
        sec.dataset.version = e.version;
        const head = document.createElement('div');
        head.className = 'release-head';
        const h2 = document.createElement('h2');
        h2.textContent = e.version;
        head.appendChild(h2);
        if (tag) {
            const b = document.createElement('span');
            b.className = 'badge' + (cmp > 0 ? ' new' : '');
            b.textContent = tag;
            head.appendChild(b);
        }
        const body = document.createElement('div');
        body.className = 'rn-content';
        Notes.renderInto(body, e.notes, t('Bu sürüm için not yok.'));
        sec.appendChild(head);
        sec.appendChild(body);
        content.appendChild(sec);
        sections.push(sec);
    }
    if (entries.length) setActive(entries[0].version);
}

// Scroll spy: the release whose heading has passed the top of the pane is the active one.
content.addEventListener('scroll', () => {
    const top = content.scrollTop + 48;
    let active = sections[0];
    for (const s of sections) {
        if (s.offsetTop <= top) active = s;
        else break;
    }
    // At the very bottom the last release wins even if its heading never reaches the top.
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 2) active = sections[sections.length - 1];
    if (active) setActive(active.dataset.version);
}, { passive: true });

Notes.interceptLinks(content, (href) => window.api.openExternal(href));

$('closeBtn').addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
});

window.api.onReleaseNotesInfo(render);
