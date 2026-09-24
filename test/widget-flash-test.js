// --widget-flash-test: yüzen widget'ın görev çubuğu yanındaki davranışını EKRANDAN ölçer.
//
// Çalıştırma (yalnız geliştirmede; main.js paketli sürümde bu dosyayı hiç yüklemiyor):
//     npx electron . --hidden --widget-flash-test
// Kurulu CopyBoard kapalı olmalı (tek örnek kilidi) ve ekranda aynı renkte ikinci bir widget
// (ör. Tauri sürümü) olmamalı: ölçüm düğmenin RENGİNİ izliyor. Fareye ~3 dk dokunmayın.
//
// Pencere dikdörtgenine bakmak yetmiyor: menü açılırken görülen flaş, içeriğin yeni pencere
// şekline birkaç kare GEÇ çizilmesinden doğuyor — pencere doğru yerdeyken içerik yanlış
// yerde. Bu düzenek DWM'in birleştirdiği ekranı GDI ile ~140 kare/sn okuyor
// (widget-flash-sampler.ps1) ve düğme rengindeki piksellerin konumunu izliyor.
//
// Bölümler (WIDGET_FLASH_PARTS=flash,repeat,geom,drag,cursor ile seçilebilir; varsayılan hepsi):
//  0. Açılış: içerik ilk düzenle mi, emniyet süresiyle mi göründü? (her koşuda)
//  1. flash — dikey: aşağıda aç/kapa, görev çubuğunun üstüne taşı (düzen aşağı→yukarı),
//     yukarıda 3× aç/kapa, geri taşı. Yatay: sağdan sola taşı, solda aç/kapa, geri taşı.
//     Ölçüt: yerleşik ya da önceki konumdan >8 px sapan kare = flaş; görünmez kare yalnız
//     düzen geçişinde kabul; aç/kapa düğmeyi yerinden oynatmamalı; düğme kırpık görünmemeli.
//     repeat — aynı düzen geçişleri 10'ar kez: gizli karenin ekrana pencere taşınmadan ÖNCE
//     çıkması bir zamanlama meselesi, tek geçiş kanıt sayılmaz.
//  2. geom — sayfanın içinden: düğme, menü ve geçmiş paneli pencereye sığıyor mu? Yukarı
//     modda menü AÇIKKEN sürükleme: önce ana süreç yolu, sonra renderer yolu (fare olayları
//     renderer'a `sendInputEvent` ile veriliyor, işletim sisteminin imleci oynamıyor).
//  3. drag — görev çubuğuna +170 px, 40 kez; son delta ve `drag-end` renderer'dan arka
//     arkaya. Sürüklerken ve bırakınca düğmenin altı çalışma alanında mı (pencereden ve
//     ekrandan)? Sağa 60 × 15 px: yan monitöre geçiyor mu?
//  4. cursor — widget imlecin olduğu yere taşınıyor (imleç oynamadan): pencere düğmenin
//     üstündeki durağan imlecin tıklamasını yakalıyor mu?
// Ham kareler için WIDGET_FLASH_DUMP=<klasör>.
//
// Taşımalar `handleWidgetAction('drag' / 'drag-end')` ile, tıklamalar sayfada düğmenin
// merkezine `click` gönderilerek (renderer'ın GERÇEK işleyicisi, daire içi denetimi dahil).
// Testler gerçek ayar dosyasında koşuyor: widgetPos, widgetSide ve widgetDockParams ÜÇÜ DE
// saklanıp sonda geri yazılıyor (Tauri'de yalnız birini geri yazmak widget'ı bozmuştu).

const { app, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { state, store } = require('../src/main/services/state');
const wm = require('../src/main/services/window-manager');

const SAMPLER = path.join(__dirname, 'widget-flash-sampler.ps1');
const TOLERANCE = 8;   // mantıksal px: bundan fazla sapma "yanlış yerde"
const VISIBLE = 250;   // bu kadar pikselden azı "görünmüyor"
const WIDGET_KEYS = ['widgetPos', 'widgetSide', 'widgetDockParams'];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, msg) => console.log(`${tag}: ${msg}`);
const fmt = (v) => (v >= 0 ? '+' : '') + Math.round(v);

function parseHex(c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Örnekleyici süreci. İşaretler (adım başlangıçları) örnekleyiciye yollanıyor ve onun
// saatiyle damgalanıyor: kareler ve adımlar aynı zaman ekseninde.
function startSampler(region, color) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SAMPLER,
        region.x, region.y, region.w, region.h, ...color].map(String);
    const proc = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const frames = [];
    const marks = [];
    const names = [];
    let buf = '';
    let err = '';
    let onReady, onFail, onEnd;
    const ready = new Promise((res, rej) => { onReady = res; onFail = rej; });
    const ended = new Promise((res) => { onEnd = res; });
    const failTimer = setTimeout(() => onFail(new Error('örnekleyici 20 sn içinde başlamadı: ' + err.trim())), 20000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            const p = line.split(' ');
            if (line === 'READY') { clearTimeout(failTimer); onReady(); }
            else if (line === 'END') onEnd();
            else if (p[0] === 'F') {
                frames.push(p[3] === '-'
                    ? { t: +p[1], n: +p[2], c: null }
                    : { t: +p[1], n: +p[2], c: [+p[3], +p[4]], top: +p[5], bottom: +p[6], left: +p[7], right: +p[8] });
            } else if (p[0] === 'M') marks[+p[2]] = { ...names[+p[2]], t: +p[1] };
        }
    });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('exit', () => { clearTimeout(failTimer); onFail(new Error('örnekleyici kapandı: ' + err.trim())); onEnd(); });
    return {
        ready,
        mark(name, opts = {}) {
            names.push({ name, ...opts });
            proc.stdin.write(`M ${names.length - 1}\n`);
        },
        async finish() {
            try { proc.stdin.write('Q\n'); } catch (e) { /* süreç zaten kapanmış */ }
            await Promise.race([ended, pause(5000)]);
            // İşaret yanıtlarının hepsi gelmiş olmalı; gelmeyen işaret adımı bozmasın.
            return { frames, marks: marks.filter(Boolean) };
        },
        kill() { try { proc.kill(); } catch (e) { /* yok */ } },
    };
}

// Bir oturumun kareleri: her adım (iki işaret arası) için düğmenin yerleşik konumu (adım
// bitmeden önceki son 250 ms'nin ortancası) ve adım boyunca ondan sapan kareler.
// Taşımada önceki adımın konumu da geçerli (düğme eskisinden yenisine gidiyor).
//
// `ack` işaretleri adım değil: düzen geçişinde ana sürecin pencereyi yeni şekline soktuğu
// (setBounds) an. Gizli karenin ekrana bundan ÖNCE çıkması gerekiyor; sonra çıkarsa pencere
// eski, görünür içerikle taşınmış demektir.
// `quiet`: yalnız sorunlu adımları yaz, sonda düzen geçişlerinin özetini ver.
function report(session, frames, allMarks, region, sc, diam, quiet = false) {
    // Ham kareler (inceleme için): WIDGET_FLASH_DUMP=<klasör>
    if (process.env.WIDGET_FLASH_DUMP) {
        try {
            require('fs').writeFileSync(path.join(process.env.WIDGET_FLASH_DUMP, `${session.replace(/[^\w]+/g, '_')}.json`),
                JSON.stringify({ region, sc, diam, marks: allMarks, frames }));
        } catch (e) { log('WIDGET_FLASH', 'döküm yazılamadı: ' + e.message); }
    }
    const marks = allMarks.filter((m) => !m.ack);
    const acks = allMarks.filter((m) => m.ack);
    const layoutStats = [];
    const visible = (f) => f.n >= VISIBLE && f.c;
    const settledAt = (b) => {
        const v = frames.filter((f) => f.t > b - 250 && f.t <= b && visible(f));
        if (!v.length) return null;
        const byPos = [...v].sort((p, q) => (p.c[0] + p.c[1]) - (q.c[0] + q.c[1]));
        const hs = v.map((f) => f.bottom - f.top + 1).sort((p, q) => p - q);
        const ns = v.map((f) => f.n).sort((p, q) => p - q);
        return { c: byPos[Math.floor(byPos.length / 2)].c, h: hs[Math.floor(hs.length / 2)], n: ns[Math.floor(ns.length / 2)] };
    };
    const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 1;
    log('WIDGET_FLASH', `── ${session}: ${frames.length} kare (~${Math.round(frames.length / (span / 1000))}/sn)`);
    const tol = TOLERANCE * sc;
    const near = (a, b) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
    const out = { jumps: 0, badHidden: 0, clipped: 0, lost: 0, moved: 0 };
    let prev = null;
    for (let k = 0; k + 1 < marks.length; k++) {
        const a = marks[k];
        const b = marks[k + 1];
        const rest = settledAt(b.t);
        if (!rest) {
            log('WIDGET_FLASH', `[${a.name}] ✗ düğme yerleşik hâlde görünmüyor`);
            out.lost++;
            prev = null;
            continue;
        }
        // Aç/kapa düğmeyi yerinden OYNATMAMALI: yerleşik konum da öncekiyle aynı olmalı.
        // (Yalnız kareler sayılsaydı kalıcı bir sıçrama "yeni yerleşik konum" sayılırdı.)
        const moved = a.still && prev && !near(rest.c, prev);
        // Konumu ancak düğmenin (neredeyse) tamamı görünen bir kare söyler. İçerik düzen
        // geçişinden sonra 120 ms'lik opaklık geçişiyle geliyor ve yarı saydam kareler arka
        // planla karışıyor: arkada mavimsi bir şey varsa eşiği geçip konumu kaydırabiliyordu
        // (ölçüldü: bir koşuda her geri gelişte bir kare −13 px). Bunlar "görünmez" sayılıyor.
        const whole = (f) => visible(f) && f.n >= 0.75 * rest.n;
        let jumped = 0;
        let hidden = 0;
        let worst = [0, 0];
        let first = null;
        let hiddenMs = [Infinity, -Infinity];
        for (const f of frames) {
            if (f.t <= a.t || f.t > b.t) continue;
            if (whole(f)) {
                if (!near(f.c, rest.c) && !(prev && near(f.c, prev))) {
                    jumped++;
                    const d = [f.c[0] - rest.c[0], f.c[1] - rest.c[1]];
                    if (Math.abs(d[0]) + Math.abs(d[1]) > Math.abs(worst[0]) + Math.abs(worst[1])) worst = d;
                    if (first === null) first = f.t - a.t;
                }
            } else {
                hidden++;
                hiddenMs = [Math.min(hiddenMs[0], f.t - a.t), Math.max(hiddenMs[1], f.t - a.t)];
            }
        }
        const hiddenOk = a.layout || a.arrival;
        const isClipped = rest.h < 0.75 * diam;
        out.jumps += jumped;
        if (!hiddenOk) out.badHidden += hidden;
        if (isClipped) out.clipped++;
        if (moved) out.moved++;
        const bad = jumped > 0 || (!hiddenOk && hidden > 0) || isClipped || moved;
        const ack = acks.find((m) => m.t > a.t && m.t <= b.t);
        const ackMs = ack ? ack.t - a.t : null;
        if (a.layout) layoutStats.push({ bad, jumped, hidden, hiddenMs, ackMs });
        if (!quiet || bad) {
            log('WIDGET_FLASH',
                `[${a.name}] ${bad ? '✗' : '✓'} yerleşik (${Math.round((region.x + rest.c[0]) / sc)},${Math.round((region.y + rest.c[1]) / sc)})`
                + (moved ? ` YER DEĞİŞTİRDİ (${fmt((rest.c[0] - prev[0]) / sc)},${fmt((rest.c[1] - prev[1]) / sc)} px)` : '')
                + ` boy ${Math.round(rest.h / sc)} px${isClipped ? ' KIRPIK' : ''}`
                + ` | yanlış yerde: ${jumped} kare`
                + (first !== null ? ` (ilki +${Math.round(first)} ms, en kötü ${fmt(worst[0] / sc)},${fmt(worst[1] / sc)} px)` : '')
                + ` | görünmez: ${hidden} kare`
                + (hidden ? ` (+${Math.round(hiddenMs[0])}..+${Math.round(hiddenMs[1])} ms${hiddenOk ? ', düzen geçişi: kabul' : ''})` : '')
                + (ackMs !== null ? ` | pencere yeni şeklinde +${Math.round(ackMs)} ms` : ''));
        }
        prev = rest.c;
    }
    if (layoutStats.length) {
        // Gizli kare ekrana pencere taşınmadan ÖNCE çıktı mı? (öncülük > 0 iyi)
        const med = (v) => { const s = [...v].sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
        const withAck = layoutStats.filter((x) => x.ackMs !== null && x.hidden);
        const lead = withAck.map((x) => x.ackMs - x.hiddenMs[0]);
        const dur = layoutStats.filter((x) => x.hidden).map((x) => x.hiddenMs[1] - x.hiddenMs[0]);
        log('WIDGET_FLASH', `   düzen geçişi: ${layoutStats.length}, sıçrayan ${layoutStats.filter((x) => x.jumped).length}`
            + ` | gizli süre ortanca ${Math.round(med(dur))} ms, en çok ${Math.round(Math.max(...dur, 0))} ms`
            + (lead.length ? ` | gizli kare pencere taşınmadan ${Math.round(med(lead))} ms önce ekranda (ortanca), en az ${Math.round(Math.min(...lead))} ms` : ''));
    }
    return out;
}

// Sayfanın içinden ölçüm: görünüm alanı ve öğelerin dikdörtgenleri (CSS px).
const PROBE_JS = `(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    const panel = document.getElementById('history-panel');
    const menu = document.getElementById('widget-menu');
    return {
        ih: window.innerHeight, iw: window.innerWidth, cls: document.body.className,
        btn: r(document.getElementById('widget-main')),
        menu: r(menu), menuOpen: menu.classList.contains('open'),
        panel: r(panel), panelOpen: panel.classList.contains('open'),
    };
})()`;

async function run() {
    // Ayarlar ŞİMDİ saklanıyor: main.js bunu widget kurulmadan önce çağırıyor. Widget kurulurken
    // `ensureWidgetInBounds` üç anahtarı da yeniden yazıyor (ör. displayId); sonradan saklamak
    // dosyadaki asıl değerleri değil onları geri yazardı.
    const orig = WIDGET_KEYS.map((k) => [k, store.get(k)]);
    const timeout = setTimeout(() => {
        log('WIDGET_FLASH', 'ZAMAN AŞIMI — ayarlar geri yazılıp çıkılıyor');
        finish();
    }, 5 * 60 * 1000);
    let restored = false;
    function finish() {
        clearTimeout(timeout);
        if (!restored) {
            restored = true;
            for (const [k, v] of orig) { if (v !== undefined) store.set(k, v); }
            log('WIDGET_FLASH', 'widget ayarları geri yazıldı: ' + JSON.stringify(Object.fromEntries(orig)));
        }
        setTimeout(() => app.exit(0), 3000);
        app.quit();
    }

    if (process.platform !== 'win32') {
        log('WIDGET_FLASH', 'yalnız Windows: ekran GDI ile okunuyor (widget-flash-sampler.ps1)');
        finish();
        return;
    }

    // Widget sayfası yüklensin, ilk düzen uygulansın.
    const t0 = Date.now();
    while (!state.widgetWindow || state.widgetWindow.isDestroyed()) {
        if (Date.now() - t0 > 15000) {
            log('WIDGET_FLASH', 'widget penceresi yok (ayarlarda kapalı olabilir)');
            finish();
            return;
        }
        await pause(10);
    }
    if (state.widgetWindow.webContents.isLoading()) {
        await new Promise((res) => state.widgetWindow.webContents.once('did-finish-load', res));
    }
    // Açılış: içerik ilk düzenle mi (hemen) yoksa emniyet süresiyle mi (1,5 sn) göründü?
    // ipcRenderer.on eşzamanlı kaydediliyor; did-finish-load'da yollanan ilk düzen kaçmamalı
    // (Tauri'de `listen` async olduğu için kaçabiliyordu, bkz. api-tauri.js ready()).
    {
        const loaded = Date.now();
        let shownAfter = null;
        while (Date.now() - loaded < 2500) {
            const pending = await state.widgetWindow.webContents
                .executeJavaScript(`document.body.classList.contains('layout-pending')`).catch(() => true);
            if (!pending) { shownAfter = Date.now() - loaded; break; }
            await pause(10);
        }
        const ok = shownAfter !== null && shownAfter < 1000;
        log('WIDGET_FLASH', `${ok ? '✓' : '✗'} açılış: içerik did-finish-load'dan ${shownAfter === null ? '2,5 sn içinde hiç' : shownAfter + ' ms sonra'} göründü`
            + (ok ? ' (ilk düzenle)' : ' (emniyet süresiyle — ilk düzen kaçtı)'));
    }
    await pause(3000);
    // Açılışta gösterilen ana pencere ölçüm bölgesinin üstüne düşebiliyor.
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.hide();

    const win = state.widgetWindow;
    const results = [];
    let sampler = null;
    // Ölçüm için: düzen geçişinde ana sürecin pencereyi yeni şekline SOKTUĞU an (relayout:true
    // bildiriminden sonraki ilk setBounds) örnekleyiciye işaretleniyor.
    let relayoutPending = false;
    const sendOrig = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => {
        if (channel === 'widget-layout' && args[0] && args[0].relayout) relayoutPending = true;
        return sendOrig(channel, ...args);
    };
    const setBoundsOrig = win.setBounds.bind(win);
    win.setBounds = (...args) => {
        if (relayoutPending) {
            relayoutPending = false;
            if (sampler) sampler.mark('ack', { ack: true });
        }
        return setBoundsOrig(...args);
    };
    try {
        const m = screen.getPrimaryDisplay();
        const wa = m.workArea;
        const sc = m.scaleFactor;
        const s = (state.widgetScale || 100) / 100;
        const btn = Math.round(68 * s);
        const colH = Math.round(68 * s);
        const diam = 48 * s * sc;
        const color = parseHex(state.widgetColor) || [0x24, 0x59, 0xd6];
        const workBottom = wa.y + wa.height;

        const xRight = Math.round(wa.x + wa.width - 300);
        const xLeft = Math.round(wa.x + wa.width * 0.4);
        const yUp = workBottom - btn - 10;
        const yDown = wa.y + 300;
        const phys = (x, y, w, h) => ({ x: Math.round(x * sc), y: Math.round(y * sc), w: Math.round(w * sc), h: Math.round(h * sc) });
        // Sağ yarıda bir sütun (görev çubuğunun içine kadar) ve üstte bir şerit.
        const column = phys(xRight - 8, yDown - 60, btn + 16, m.bounds.y + m.bounds.height - (yDown - 60));
        const band = phys(xLeft - 60, yDown - 20, xRight - xLeft + btn + 120, btn + 40);
        log('WIDGET_FLASH', `monitör ${m.bounds.width}x${m.bounds.height} ×${sc}, çalışma alanı altı y=${workBottom}, `
            + `ölçek ${s}, renk ${state.widgetColor}; sağ x=${xRight}, sol x=${xLeft}, yukarı-mod y=${yUp}, aşağı-mod y=${yDown}`);

        let dragId = 7000000;
        const moveTo = (x, y) => {
            dragId++;
            const cur = state.widgetPos;
            wm.handleWidgetAction('drag', { x: x - cur.x, y: y - cur.y, id: dragId });
            wm.handleWidgetAction('drag-end', { id: dragId });
        };
        const exec = (js) => win.webContents.executeJavaScript(js);
        const click = () => exec(`(() => { const b = document.getElementById('widget-main'); const r = b.getBoundingClientRect();
            b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); })()`);
        const escape = () => exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        const probe = () => exec(PROBE_JS);
        // Düğmenin üst kenarı (ekran, mantıksal) pencereden: kapalıyken düğme pencerenin DİBİNDE —
        // aşağı modda pencere zaten düğme boyunda, yukarı modda düğmenin üstüne doğru uzun.
        const buttonTop = () => { const b = win.getBounds(); return b.y + b.height - colH; };

        // Bölümler: WIDGET_FLASH_PARTS=flash,repeat,geom,drag,cursor (varsayılan hepsi).
        const parts = (process.env.WIDGET_FLASH_PARTS || 'flash,repeat,geom,drag,cursor').split(',').map((x) => x.trim());
        const want = (x) => parts.includes(x);
        let r;
        let flashOk = true;
        let geomBad = 0;
        let dragOk = true;
        let crossOk = true;
        let cursorBad = 0;

        if (want('flash')) {
            // ── 1. flash: dikey oturum ───────────────────────────────────────────────────────────
            moveTo(xLeft, yDown); // taban temiz alınsın: düğme sütunun dışında
            await pause(900);
            sampler = startSampler(column, color);
            await sampler.ready;
            await pause(200);
            sampler.mark('aşağıya taşındı', { arrival: true });
            moveTo(xRight, yDown);
            await pause(1000);
            sampler.mark('aşağı: aç', { still: true });
            await click();
            await pause(800);
            sampler.mark('aşağı: kapat', { still: true });
            await click();
            await pause(1000);
            sampler.mark('görev çubuğunun üstüne (düzen aşağı→yukarı)', { layout: true });
            moveTo(xRight, yUp);
            await pause(1000);
            for (let i = 1; i <= 3; i++) {
                sampler.mark(`yukarı: aç #${i}`, { still: true });
                await click();
                await pause(800);
                sampler.mark(`yukarı: kapat #${i}`, { still: true });
                await click();
                await pause(1000);
            }
            sampler.mark('yukarıdan geri (düzen yukarı→aşağı)', { layout: true });
            moveTo(xRight, yDown);
            await pause(1000);
            sampler.mark('son');
            r = await sampler.finish();
            sampler = null;
            results.push(report('dikey', r.frames, r.marks, column, sc, diam));

            // ── 1. flash: yatay oturum ───────────────────────────────────────────────────────────
            moveTo(xRight, yDown + 200); // şeridin dışında; taraf ve yön aynı
            await pause(900);
            sampler = startSampler(band, color);
            await sampler.ready;
            await pause(200);
            sampler.mark('şeride', { arrival: true });
            moveTo(xRight, yDown);
            await pause(1000);
            sampler.mark('sola (taraf sağ→sol)', { layout: true });
            moveTo(xLeft, yDown);
            await pause(1000);
            sampler.mark('sol: aç', { still: true });
            await click();
            await pause(800);
            sampler.mark('sol: kapat', { still: true });
            await click();
            await pause(1000);
            sampler.mark('sağa (taraf sol→sağ)', { layout: true });
            moveTo(xRight, yDown);
            await pause(1000);
            sampler.mark('son');
            r = await sampler.finish();
            sampler = null;
            results.push(report('yatay', r.frames, r.marks, band, sc, diam));
        }

        if (want('repeat')) {
            // ── 1. repeat: düzen geçişi tekrarları ───────────────────────────────────────────────
            // Gizli karenin ekrana pencere taşınmadan önce çıkması bir zamanlama meselesi: tek
            // geçiş kanıt sayılmaz. Her yönde 2 × REPEAT geçiş.
            const REPEAT = 10;
            moveTo(xRight, yDown + 200); // şeridin dışında
            await pause(900);
            sampler = startSampler(band, color);
            await sampler.ready;
            await pause(200);
            sampler.mark('şeride', { arrival: true });
            moveTo(xRight, yDown);
            await pause(800);
            for (let i = 1; i <= REPEAT; i++) {
                sampler.mark(`sola #${i}`, { layout: true });
                moveTo(xLeft, yDown);
                await pause(700);
                sampler.mark(`sağa #${i}`, { layout: true });
                moveTo(xRight, yDown);
                await pause(700);
            }
            sampler.mark('son');
            r = await sampler.finish();
            sampler = null;
            results.push(report(`yatay ×${REPEAT}`, r.frames, r.marks, band, sc, diam, true));

            moveTo(xLeft, yDown); // sütunun dışında
            await pause(900);
            sampler = startSampler(column, color);
            await sampler.ready;
            await pause(200);
            sampler.mark('sütuna', { arrival: true });
            moveTo(xRight, yDown);
            await pause(800);
            for (let i = 1; i <= REPEAT; i++) {
                sampler.mark(`yukarı #${i}`, { layout: true });
                moveTo(xRight, yUp);
                await pause(700);
                sampler.mark(`aşağı #${i}`, { layout: true });
                moveTo(xRight, yDown);
                await pause(700);
            }
            sampler.mark('son');
            r = await sampler.finish();
            sampler = null;
            results.push(report(`dikey ×${REPEAT}`, r.frames, r.marks, column, sc, diam, true));
        }

        if (results.length) {
            const flash = results.reduce((acc, x) => {
                for (const k of Object.keys(acc)) acc[k] += x[k];
                return acc;
            }, { jumps: 0, badHidden: 0, clipped: 0, lost: 0, moved: 0 });
            flashOk = !flash.jumps && !flash.badHidden && !flash.clipped && !flash.lost && !flash.moved;
            log('WIDGET_FLASH', `SONUÇ — yanlış yerde ${flash.jumps} kare, düzen geçişi dışında görünmez ${flash.badHidden} kare, `
                + `aç/kapa ile yer değiştiren ${flash.moved} adım, kırpık ${flash.clipped} adım, kayıp ${flash.lost} adım → ${flashOk ? 'FLAŞ YOK' : 'SORUN VAR'}`);
        }

        if (want('geom')) {
            // ── 2. geom: öğeler pencereye sığıyor mu? ────────────────────────────────────────────
            const fits = (label, rect, ih) => {
                const over = Math.max(0, -rect.top);
                const under = Math.max(0, rect.bottom - ih);
                const ok = !over && !under;
                if (!ok) geomBad++;
                log('WIDGET_GEOM', `${ok ? '✓' : '✗'} ${label}: ${rect.top}..${rect.bottom} / pencere 0..${ih}`
                    + (over ? ` — üstten ${over} px dışarıda` : '') + (under ? ` — alttan ${under} px dışarıda` : ''));
            };
            // Ölçek değişimi (Ayarlar → Yüzen araç → Boyut): pencere yeni ölçekte, yön yeniden
            // hesaplanıyor. Yalnız bellekte; ayar dosyasına yazılmıyor, sonra geri alınıyor.
            {
                const scaleOrig = state.widgetScale;
                state.widgetScale = 150;
                for (const [mode, y] of [['aşağı', yDown], ['yukarı', workBottom - Math.round(68 * 1.5) - 10]]) {
                    moveTo(xRight, y);
                    await pause(300);
                    wm.updateWidgetScale(150);
                    await pause(700);
                    const p = await probe();
                    fits(`%150 ölçek, ${mode}, kapalı: düğme (${p.cls.includes('up-side') ? 'yukarı' : 'aşağı'} düzen)`, p.btn, p.ih);
                }
                state.widgetScale = scaleOrig;
                wm.updateWidgetScale(scaleOrig);
                await pause(700);
            }
            for (const [mode, y] of [['aşağı', yDown], ['yukarı', yUp]]) {
                moveTo(xRight, y);
                await pause(900);
                let p = await probe();
                fits(`${mode}, kapalı: düğme`, p.btn, p.ih);
                await click();
                await pause(800);
                p = await probe();
                fits(`${mode}, menü: menü sütunu`, p.menu, p.ih);
                await exec(`document.getElementById('btn-snippet').click()`);
                await pause(900);
                p = await probe();
                fits(`${mode}, geçmiş: panel`, p.panel, p.ih);
                await escape();
                await pause(900);
            }

            // ── 2. geom: yukarı modda menü AÇIKKEN sürükleme (150 px yukarı) ─────────────────────
            // a) Ana süreç yolu: renderer'dan bağımsız, yalnız 'drag'/'drag-end' konumu doğru mu?
            moveTo(xRight, yUp);
            await pause(900);
            await click();
            await pause(800);
            {
                const before = { ...state.widgetPos };
                dragId++;
                wm.handleWidgetAction('drag', { x: 0, y: -150, id: dragId });
                wm.handleWidgetAction('drag-end', { id: dragId });
                await pause(900);
                const dev = state.widgetPos.y - (before.y - 150);
                const ok = Math.abs(dev) <= TOLERANCE;
                if (!ok) geomBad++;
                log('WIDGET_DRAG', `${ok ? '✓' : '✗'} menü açıkken sürükleme, ana süreç: başlangıç y=${before.y}, beklenen ≈${before.y - 150}, `
                    + `bırakınca y=${state.widgetPos.y} (sapma ${fmt(dev)})`);
                await escape();
                await pause(900);
            }
            // b) Renderer yolu: gerçek fare olayları (pointerdown → move → up), işletim sisteminin
            //    imlecine dokunmadan `sendInputEvent` ile.
            moveTo(xRight, yUp);
            await pause(900);
            await click();
            await pause(800);
            {
                const p = await probe();
                const zoom = win.webContents.getZoomFactor();
                const b = win.getBounds();
                const cx = Math.round(((p.btn.left + p.btn.right) / 2) * zoom);
                const cy = Math.round(((p.btn.top + p.btn.bottom) / 2) * zoom);
                const before = { ...state.widgetPos };
                if (cy < 0 || cy > b.height) {
                    geomBad++;
                    log('WIDGET_DRAG', `✗ menü açıkken sürükleme, renderer: düğmenin merkezi pencerenin dışında (y=${cy}, pencere 0..${b.height}) — tutulamıyor`);
                } else {
                    const send = (type, dy, extra) => win.webContents.sendInputEvent({
                        type, x: cx, y: cy + dy, globalX: b.x + cx, globalY: b.y + cy + dy, ...extra,
                    });
                    send('mouseDown', 0, { button: 'left', clickCount: 1 });
                    for (let k = 1; k <= 15; k++) {
                        await pause(16);
                        send('mouseMove', -10 * k, { modifiers: ['leftButtonDown'] });
                    }
                    await pause(40);
                    send('mouseUp', -150, { button: 'left', clickCount: 1 });
                    await pause(1200);
                    const p2 = await probe();
                    const b2 = win.getBounds();
                    const shownTop = Math.round(b2.y + p2.btn.top * zoom);
                    const want = before.y - 150;
                    const dev = state.widgetPos.y - want;
                    // Düğme kapalı çerçevenin 8-12 px içinde (yukarı/aşağı modda padding farkı).
                    const ok = Math.abs(dev) <= TOLERANCE && Math.abs(shownTop - state.widgetPos.y - 10 * s) <= TOLERANCE;
                    if (!ok) geomBad++;
                    log('WIDGET_DRAG', `${ok ? '✓' : '✗'} menü açıkken sürükleme, renderer: başlangıç y=${before.y}, beklenen ≈${want}, `
                        + `bırakınca y=${state.widgetPos.y} (sapma ${fmt(dev)}), ekranda düğme üstü y=${shownTop}, menü ${p2.menuOpen ? 'AÇIK' : 'kapalı'}`);
                }
                await escape();
                await pause(900);
            }
        }

        if (want('drag')) {
            // ── 3. drag: görev çubuğuna ──────────────────────────────────────────────────────────
            const debugLive = typeof wm.debugWidgetDrag === 'function' ? wm.debugWidgetDrag : null;
            const startX = xRight;
            const startY = workBottom - 150;
            const dragRegion = phys(startX - 8, startY - 40, btn + 16, m.bounds.y + m.bounds.height - (startY - 40));
            moveTo(xRight, yDown); // taban temiz alınsın
            await pause(900);
            sampler = startSampler(dragRegion, color);
            await sampler.ready;
            await pause(200);
            const runs = 40;
            let midOutside = 0;
            let outside = 0;
            let stale = 0;
            for (let i = 0; i < runs; i++) {
                moveTo(startX, startY);
                await pause(150);
                const id = 1000000 + i;
                // Renderer'ın yolu: sürükleme deltası IPC ile.
                await exec(`window.api.widgetAction('drag', { x: 0, y: 170, id: ${id} })`);
                await pause(120);
                if (buttonTop() + colH > workBottom + 0.5) midOutside++;
                sampler.mark(`orta ${i}`, { kind: 'mid' });
                // Bırakma anı: kalan delta ve 'drag-end' renderer'dan ARKA ARKAYA (widget.js pointerup).
                await exec(`window.api.widgetAction('drag', { x: 0, y: 6, id: ${id} }); window.api.widgetAction('drag-end', { id: ${id} });`);
                await pause(250);
                if (debugLive && debugLive()) stale++;
                if (buttonTop() + colH > workBottom + 0.5) outside++;
                sampler.mark(`son ${i}`, { kind: 'end' });
            }
            r = await sampler.finish();
            sampler = null;
            // Ekrandan: işaretten önceki 80 ms'de görünen düğmenin alt kenarı.
            const bottomPx = (workBottom * sc) - dragRegion.y;
            let pixMid = 0;
            let pixEnd = 0;
            let worstBelow = 0;
            for (const mk of r.marks) {
                const v = r.frames.filter((f) => f.t > mk.t - 80 && f.t <= mk.t && f.n >= VISIBLE && f.c);
                if (!v.length) continue;
                const below = Math.max(...v.map((f) => f.bottom)) + 1 - bottomPx;
                if (below > 0.5 * sc) {
                    if (mk.kind === 'mid') pixMid++; else pixEnd++;
                    worstBelow = Math.max(worstBelow, below / sc);
                }
            }
            dragOk = !midOutside && !outside && !stale && !pixMid && !pixEnd;
            log('WIDGET_DRAG', `${dragOk ? '✓' : '✗'} ${runs} bırakmada — sürükleme ORTASINDA görev çubuğunda: pencere ${midOutside}, ekran ${pixMid}; `
                + `bırakınca görev çubuğunda: pencere ${outside}, ekran ${pixEnd}`
                + (worstBelow ? ` (en kötü ${Math.round(worstBelow)} px altta)` : '')
                + `; canlı konum temizlenmedi: ${debugLive ? stale : 'ölçülemedi (eski kod)'}`);

            // ── 3. drag: yan monitöre geçiş ──────────────────────────────────────────────────────
            // Sürüklerken sıkıştırma, küçük adımlarla ilerleyen bir sürüklemeyi monitör kenarında
            // HAPSETMEMELİ.
            const right = screen.getAllDisplays().find((d) => Math.abs(d.bounds.x - (m.bounds.x + m.bounds.width)) < 1);
            if (!right) {
                log('WIDGET_DRAG', 'sağda bitişik monitör yok, geçiş sınaması atlandı');
            } else {
                moveTo(m.bounds.x + m.bounds.width - 400, wa.y + 300);
                await pause(400);
                const id = 9000000;
                for (let k = 0; k < 60; k++) wm.handleWidgetAction('drag', { x: 15, y: 0, id });
                wm.handleWidgetAction('drag-end', { id });
                await pause(600);
                const x = state.widgetPos.x;
                crossOk = x >= right.bounds.x;
                log('WIDGET_DRAG', `${crossOk ? '✓' : '✗'} yan monitöre geçiş — düğme x=${x} (sağ monitör ${right.bounds.x}..${right.bounds.x + right.bounds.width}): `
                    + (crossOk ? 'GEÇTİ' : 'KENARDA TAKILDI'));
            }
        }

        if (want('cursor')) {
            // ── 4. cursor: widget imlecin ALTINA taşınınca tıklanabilir mi? ──────────────────────
            // Yakalama/geçirgenlik kararı renderer'da, bildiği son fare konumuyla veriliyor ve
            // pencere durağan imlecin altında taşınınca o konum bayatlıyordu. Gerçek imlece
            // dokunmadan: widget imlecin olduğu yere taşınıyor, karar sayfadan okunuyor.
            const c = screen.getCursorScreenPoint();
            const cwa = screen.getDisplayNearestPoint(c).workArea;
            const tx = Math.round(c.x - btn / 2);
            const ty = Math.round(c.y - colH / 2);
            const edge = Math.min(tx - cwa.x, cwa.x + cwa.width - btn - tx, ty - cwa.y, cwa.y + cwa.height - colH - ty);
            if (edge < 70) {
                log('WIDGET_CURSOR', `imleç (${c.x},${c.y}) çalışma alanının kenarına çok yakın (kenara yapışma düğmeyi kaydırır), sınama atlandı`);
            } else {
                const readState = () => exec(`({ ignore: lastIgnoreState, x: lastMouseX, y: lastMouseY })`);
                const check = async (label) => {
                    const st = await readState();
                    const b = win.getBounds();
                    const p = await probe();
                    const zoom = win.webContents.getZoomFactor();
                    const bx = b.x + ((p.btn.left + p.btn.right) / 2) * zoom;
                    const by = b.y + ((p.btn.top + p.btn.bottom) / 2) * zoom;
                    const over = Math.hypot(c.x - bx, c.y - by) <= 20 * zoom;
                    const ok = !over || st.ignore === false;
                    if (!ok) cursorBad++;
                    log('WIDGET_CURSOR', `${ok ? '✓' : '✗'} ${label}: imleç düğmenin ${over ? 'üstünde' : 'DIŞINDA (geçersiz)'}, `
                        + `pencere ${st.ignore === false ? 'tıklamayı yakalıyor' : st.ignore === true ? 'GEÇİRGEN — tıklama alttaki uygulamaya gider' : 'durumu bilinmiyor'}`);
                };
                // Önce ekranın öbür yarısına ve öbür yöne: imlecin altına gelmek düzeni değiştirsin.
                const leftHalf = tx < cwa.x + cwa.width / 2;
                const upThere = (cwa.y + cwa.height) - ty < Math.round(420 * s);
                moveTo(leftHalf ? cwa.x + cwa.width - btn - 200 : cwa.x + 200, upThere ? cwa.y + 200 : cwa.y + cwa.height - colH - 100);
                await pause(700);
                moveTo(tx, ty);
                await pause(700);
                await check('imlecin altına taşındı (düzen değişti)');
                moveTo(tx + 8, ty);
                await pause(500);
                await check('imlecin altında 8 px kaydı (düzen aynı)');
            }
        }

        const allOk = flashOk && !geomBad && dragOk && crossOk && !cursorBad;
        log('WIDGET_FLASH', `GENEL — ${allOk ? 'HEPSİ GEÇTİ' : 'SORUN VAR'} (flaş ${flashOk ? '✓' : '✗'}, geometri/menü-sürükleme ${geomBad ? '✗' : '✓'}, `
            + `görev çubuğu ${dragOk ? '✓' : '✗'}, yan monitör ${crossOk ? '✓' : '✗'}, durağan imleç ${cursorBad ? '✗' : '✓'})`);
    } catch (e) {
        log('WIDGET_FLASH', 'HATA: ' + (e && e.stack || e));
    } finally {
        if (sampler) sampler.kill();
        await pause(500);
        finish();
    }
}

module.exports = { run };
