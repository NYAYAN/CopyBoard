// Release notes renderer (src/renderer/shared/release-notes.js) — the pure half: Markdown
// to HTML and version comparison. The script is a classic browser script that leaves
// `CopyBoardNotes` on the global, so it runs here in a vm context; the DOM half
// (sanitizer, headings) is never called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(ROOT, 'src/renderer/shared/release-notes.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(source, ctx);
const N = ctx.CopyBoardNotes;
const json = (v) => JSON.stringify(v); // values come from another realm

test('a wrapped list item stays one item — the 3.2.2 dialog showed it cut in half', () => {
    const md = [
        '## 🐛 Düzeltmeler',
        '',
        '- **Kaydı durdurmak için iki kez tıklamak gerekiyordu (macOS).** Kayıt sürerken başka',
        "  bir uygulamaya geçtiyseniz Durdur'a ilk tık boşa gidiyordu: macOS onu yalnızca kayıt",
        '  penceresini öne almak için kullanıyordu. Artık kayıt ilk tıkta duruyor.',
    ].join('\n');
    const html = N.markdownToHtml(md);
    assert.equal((html.match(/<li>/g) || []).length, 1);
    assert.ok(!html.includes('<p>'), 'the continuation must not become a paragraph');
    assert.ok(!html.includes('<br>'), 'no hard line breaks inside the item');
    assert.ok(
        html.includes('<strong>Kaydı durdurmak için iki kez tıklamak gerekiyordu (macOS)</strong>'),
        'title on its own, without the trailing full stop'
    );
    assert.ok(html.includes('<span>Kayıt sürerken başka bir uygulamaya geçtiyseniz'), 'description joined with a space');
    assert.ok(html.endsWith('Artık kayıt ilk tıkta duruyor.</span></li></ul>'));
});

test('lines inside a paragraph are a soft break (a space), not <br>', () => {
    assert.equal(N.markdownToHtml('Satır bir\nsatır iki'), '<p>Satır bir satır iki</p>');
});

test('a title ending in an ellipsis keeps it', () => {
    assert.ok(N.markdownToHtml('- **Bekleniyor...** sonra').includes('<strong>Bekleniyor...</strong>'));
});

test('pipe tables render as tables', () => {
    const md = '| | Electron 39 | Tauri 2 |\n|---|---|---|\n| Uygulama boyutu | 305 MB | **36 MB** |\n| Süreç sayısı | 10 | **4** |';
    assert.equal(
        N.markdownToHtml(md),
        '<table><thead><tr><th></th><th>Electron 39</th><th>Tauri 2</th></tr></thead><tbody>' +
            '<tr><td>Uygulama boyutu</td><td>305 MB</td><td><strong>36 MB</strong></td></tr>' +
            '<tr><td>Süreç sayısı</td><td>10</td><td><strong>4</strong></td></tr></tbody></table>'
    );
});

test('numbered lists, headings and rules', () => {
    assert.equal(N.markdownToHtml('1. bir\n2. iki'), '<ol><li>bir</li><li>iki</li></ol>');
    assert.equal(N.markdownToHtml('# Başlık'), '<h3>Başlık</h3>');
    assert.equal(N.markdownToHtml('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
});

test('markup in the notes is escaped, never passed through', () => {
    const html = N.markdownToHtml('- <script>alert(1)</script> "tırnak" & <img src=x onerror=alert(1)>');
    assert.ok(!/<script|<img/i.test(html));
    assert.ok(html.includes('&lt;script&gt;') && html.includes('&quot;tırnak&quot;') && html.includes('&amp;'));
});

test('only http(s) links become anchors', () => {
    assert.ok(N.markdownToHtml('[site](https://example.com)').includes('<a href="https://example.com">site</a>'));
    assert.ok(!N.markdownToHtml('[x](javascript:alert(1))').includes('<a'));
});

test('version comparison is numeric, not textual', () => {
    assert.equal(N.compareVersions('3.2.10', '3.2.9'), 1);
    assert.equal(N.compareVersions('v3.2.1', '3.2.1'), 0);
    assert.equal(N.compareVersions('2.12.0', '3.0.0'), -1);
    assert.equal(json(N.parseVersion('v3.2')), json([3, 2, 0]));
});

test('newerThan keeps only versions above the installed one', () => {
    const log = [{ version: '3.2.2' }, { version: '3.2.1' }, { version: '3.2.0' }, { version: '3.1.1' }];
    assert.equal(json(N.newerThan(log, '3.2.0').map((e) => e.version)), json(['3.2.2', '3.2.1']));
    assert.equal(N.newerThan(null, '3.2.0').length, 0);
});

test('section headings map to an icon kind', () => {
    assert.equal(N.headingKind('🐛 Düzeltmeler'), 'fix');
    assert.equal(N.headingKind('✨ Yeni'), 'new');
    assert.equal(N.headingKind('⚠️ Son kez elle kurulum'), 'warn');
    assert.equal(N.headingKind('🔐 İzinler azaldı'), 'security');
    assert.equal(N.headingKind('📦 Ölçülen fark'), 'improve');
    assert.equal(N.headingKind('Teşekkürler'), 'note');
});

test('every release in CHANGELOG.md keeps one <li> per bullet', async () => {
    const lines = (await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8')).split('\n');
    const sections = [];
    let cur = null;
    for (const line of lines) {
        const m = /^# CopyBoard v(\d+\.\d+\.\d+) Release Notes$/.exec(line.trim());
        if (m) sections.push((cur = { version: m[1], body: [], done: false }));
        else if (cur && !cur.done) {
            if (line.trim() === '---') cur.done = true;
            else cur.body.push(line);
        }
    }
    assert.ok(sections.length >= 20, `found only ${sections.length} releases`);
    for (const s of sections) {
        const bullets = s.body.filter((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l) && !/^\s*(-{3,}|\*{3,})\s*$/.test(l)).length;
        const items = (N.markdownToHtml(s.body.join('\n')).match(/<li>/g) || []).length;
        assert.equal(items, bullets, `v${s.version}: ${bullets} bullets but ${items} <li>`);
    }
});
