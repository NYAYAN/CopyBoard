// Ekran görüntüsü üretici — README'deki görselleri yeniden üretir.
//
//   npx electron scripts/capture-screens.js
//
// Uygulamanın GERÇEK renderer dosyalarını, gerçek preload'ı ile açar; ama ana süreç
// yerine bu dosyadaki sahte IPC uçlarına bağlar. Yani ekranlar birebir uygulamadaki
// kodla çizilir, veriler ise buradaki demo verisidir: kullanıcının panosu, ekran
// görüntüleri klasörü ve ayarları hiç okunmaz, hiç yazılmaz (userData geçici bir
// klasöre alınır). Böylece görseller herkeste aynı çıkar ve kimsenin özel verisi
// repoya sızmaz.
//
// Çıktı: docs/screenshots/*.png

const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.js');
const OUT = path.join(ROOT, 'docs', 'screenshots');

// Yakalama katmanlarının (snipper/OCR/kaydırma/video) üstüne oturduğu sahte masaüstü.
const STAGE_W = 1440;
const STAGE_H = 900;

// Kullanıcının gerçek electron-store'una dokunmamak için.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'copyboard-shots-')));

// ── Demo verisi ──────────────────────────────────────────────────────────────

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

const HISTORY = [
    { id: 'h1', content: 'https://github.com/NYAYAN/CopyBoard/releases', timestamp: ago(2) },
    { id: 'h2', content: '#8957e5', timestamp: ago(6) },
    { id: 'h3', content: 'npm run dist', timestamp: ago(14) },
    { id: 'h4', content: 'SELECT id, ad, soyad FROM musteriler WHERE aktif = 1\nORDER BY kayit_tarihi DESC;', timestamp: ago(31) },
    { id: 'h5', content: 'Toplantı notu: sürüm planı salı 14:00, test takvimi çarşamba paylaşılacak.', timestamp: ago(58) },
    { id: 'h6', content: '~/Work/Repos/CopyBoard/src/renderer', timestamp: ago(96) },
    { id: 'h7', content: 'destek@ornek.com.tr', timestamp: ago(140) },
    { id: 'h8', content: 'fatura-2026-08.pdf', timestamp: ago(190) },
    { id: 'h9', content: 'Kargo takip: 4059 8817 2233', timestamp: ago(240) },
    { id: 'h10', content: 'const t = (s) => window.CopyBoardI18n.t(s);', timestamp: ago(320) },
    { id: 'h11', content: 'Sunum için kapak görselini yeniden ölçeklendir (1920x1080).', timestamp: ago(400) },
    { id: 'h12', content: 'https://tr.wikipedia.org/wiki/Optik_karakter_tanıma', timestamp: ago(520) }
];

const FAVORITES = [
    { id: 'f1', content: 'Merhaba,\n\nTalebiniz tarafımıza ulaştı. En kısa sürede dönüş yapacağız.\n\nİyi çalışmalar.', note: 'Müşteri mail taslağı', timestamp: ago(30) },
    { id: 'f2', content: 'TR12 0006 4000 0011 2345 6789 01', note: 'Şirket IBAN', timestamp: ago(1440) },
    { id: 'f3', content: 'destek@ornek.com.tr', note: 'Destek adresi', timestamp: ago(2880) },
    { id: 'f4', content: '#8957e5', note: 'Marka moru', timestamp: ago(4320) },
    { id: 'f5', content: 'ssh kullanici@sunucu.ornek.com.tr -p 2222', note: 'Test sunucusu', timestamp: ago(5760) }
];

const SETTINGS = {
    appVersion: require(path.join(ROOT, 'package.json')).version,
    maxItems: 50, quickPasteCount: 20,
    globalShortcut: 'Alt+V', globalShortcutImage: 'Alt+9', globalShortcutVideo: 'Alt+8',
    globalShortcutOcr: 'Alt+2', globalShortcutColor: 'Alt+3', globalShortcutScroll: 'Alt+4',
    globalShortcutPaste: 'CommandOrControl+Shift+V',
    shortcutsEnabled: { list: true, draw: true, video: true, ocr: true, color: true, scroll: true, paste: true },
    autoStart: true, videoQuality: 'high', clipboardPaused: false,
    showWidget: true, widgetTransparent: false, widgetColor: '#8957e5',
    widgetOpacity: 100, widgetScale: 100
};

// Dil ve tema: uygulamanın varsayılanları (Türkçe + koyu). Açık tema çekimi bunu
// geçici olarak değiştirir.
let LANG = 'tr';
let THEME = 'dark';
const DICTS = { en: require(path.join(ROOT, 'src', 'shared', 'i18n', 'en.json')), tr: {} };

// ── Sahte IPC ────────────────────────────────────────────────────────────────
// Preload yalnızca bu beşinden veri bekler; geri kalan her şey `send`, yani
// dinleyicisi olmayınca sessizce düşer.

function registerStubs() {
    ipcMain.on('i18n-get', (e) => { e.returnValue = { lang: LANG, dict: DICTS[LANG] || {} }; });
    ipcMain.on('theme-get', (e) => { e.returnValue = { mode: THEME, resolved: THEME }; });
    ipcMain.handle('get-history', () => ({ history: HISTORY, favorites: FAVORITES }));
    ipcMain.handle('get-settings', () => SETTINGS);
    ipcMain.handle('get-audio-settings', () => ({ mic: false, system: false }));
    ipcMain.handle('get-screenshots', () => gallery);
    ipcMain.handle('ensure-mic-permission', () => true);
}

// Yakalama katmanları hazır olduklarını 'snip-ready' ile bildirir; onları
// beklemek için tek seferlik bir söz kuyruğu.
const readyWaiters = [];
ipcMain.on('snip-ready', () => { const w = readyWaiters.shift(); if (w) w(); });
const waitReady = (ms = 8000) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms); // hazır demezse yine de devam et
    readyWaiters.push(() => { clearTimeout(timer); resolve(); });
});

// ── Yardımcılar ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkWin(opts = {}) {
    return new BrowserWindow({
        show: false,
        frame: false,
        backgroundColor: '#00000000',
        ...opts,
        webPreferences: {
            preload: PRELOAD,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            ...(opts.webPreferences || {})
        }
    });
}

async function load(win, file) {
    const done = new Promise((r) => win.webContents.once('did-finish-load', r));
    win.loadFile(file);
    await done;
    await sleep(400); // yazı tipleri + ilk çizim
}

async function loadHTML(win, html) {
    const done = new Promise((r) => win.webContents.once('did-finish-load', r));
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await done;
    await sleep(250);
}

// Fareyi Chromium'un girdi katmanından sürer: renderer'lar için gerçek imleçten
// ayırt edilemez, dolayısıyla seçim/çizim akışları olduğu gibi çalışır.
async function drag(win, from, to, steps = 12) {
    const wc = win.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
    wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
        const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
        const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        await sleep(16);
    }
    return () => {
        wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
        return sleep(250);
    };
}

async function click(win, x, y) {
    const wc = win.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(40);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(40);
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(200);
}

// README bir görseli en fazla ~830px genişlikte gösterir; 1800px, Retina'da bile
// 1:1'in üstünde kalır. Tam ekran katmanların ham 2880px'i repoyu şişirmekten
// başka bir işe yaramıyor.
const MAX_W = 1800;

function write(name, image) {
    const s = image.getSize();
    const out = s.width > MAX_W ? image.resize({ width: MAX_W, quality: 'best' }) : image;
    fs.writeFileSync(path.join(OUT, name + '.png'), out.toPNG());
    const o = out.getSize();
    console.log(`  ✓ ${name}.png  ${o.width}×${o.height}`);
}

// CSS koordinatlarıyla verilen bir dikdörtgeni yakalanan kareden keser.
function cropDip(image, rect, pad = 8) {
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    const s = image.getSize();
    const x = Math.max(0, Math.round((rect.x - pad) * sf));
    const y = Math.max(0, Math.round((rect.y - pad) * sf));
    return image.crop({
        x, y,
        width: Math.min(Math.round((rect.w + pad * 2) * sf), s.width - x),
        height: Math.min(Math.round((rect.h + pad * 2) * sf), s.height - y)
    });
}

// Saydam pencereler (widget, hızlı yapıştır, bildirim, güncelleme) alfa kanalıyla
// çıkar; GitHub açık temada bunları okunmaz hale getirir. Bu yüzden yakalanan kare
// nötr bir zemine, gölgesiyle birlikte yerleştirilir.
const DARK_BACKDROP = 'radial-gradient(120% 120% at 30% 0%, #2a2a33 0%, #14141a 60%, #0d0d11 100%)';
const LIGHT_BACKDROP = 'radial-gradient(120% 120% at 30% 0%, #ffffff 0%, #eceaf3 60%, #ddd9e8 100%)';

async function onBackdrop(image, pad = 56, backdrop = DARK_BACKDROP) {
    // capturePage FİZİKSEL piksel döndürür; zemin penceresi ise mantıksal piksellerle
    // ölçülür. Ölçeğe bölmeden yerleştirmek kareyi bir kez daha büyütür, yani bulanıklaştırır.
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    const px = image.getSize();
    const iw = Math.round(px.width / sf);
    const ih = Math.round(px.height / sf);
    const w = iw + pad * 2;
    const h = ih + pad * 2;
    const win = mkWin({ width: w, height: h, backgroundColor: '#1b1b20' });
    const shadow = backdrop === LIGHT_BACKDROP ? '0 18px 40px rgba(40,32,70,.22)' : '0 18px 40px rgba(0,0,0,.55)';
    await loadHTML(win, `<body style="margin:0;width:${w}px;height:${h}px;display:flex;
        align-items:center;justify-content:center;background:${backdrop}">
        <img src="${image.toDataURL()}" style="width:${iw}px;height:${ih}px;
             filter:drop-shadow(${shadow})"></body>`);
    const out = await win.webContents.capturePage();
    win.destroy();
    return out;
}

// ── Sahne: yakalama araçlarının altına serilen sahte masaüstü ────────────────

const stagePage = (title, accent, body) => `
<html lang="tr"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden;
       font:15px/1.65 -apple-system,'Segoe UI',system-ui,sans-serif;color:#1d1d20;
       background:linear-gradient(135deg,#3b2f63 0%,#243b55 55%,#1b2430 100%);
       display:flex;align-items:center;justify-content:center}
  .win{width:1120px;height:740px;background:#fff;border-radius:12px;overflow:hidden;
       box-shadow:0 30px 70px rgba(0,0,0,.45);display:flex;flex-direction:column}
  .bar{height:44px;background:#f1f1f4;border-bottom:1px solid #e2e2e8;display:flex;
       align-items:center;gap:8px;padding:0 14px;flex:none}
  .dot{width:11px;height:11px;border-radius:50%}
  .url{flex:1;margin-left:10px;height:26px;border-radius:13px;background:#fff;
       border:1px solid #e2e2e8;font-size:12px;color:#6b6b75;display:flex;
       align-items:center;padding:0 12px}
  .doc{flex:1;padding:38px 56px;overflow:hidden}
  h1{font-size:30px;margin:0 0 6px;letter-spacing:-.4px}
  .meta{color:#8a8a95;font-size:13px;margin-bottom:26px}
  p{margin:0 0 15px;max-width:66ch;color:#33333a}
  .tag{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;
       background:${accent}1a;color:${accent};font-weight:600;margin-bottom:14px}
  table{border-collapse:collapse;width:100%;margin-top:22px;font-size:14px}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #ececf1}
  th{color:#6b6b75;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body><div class="win">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span class="url">ornek.com.tr/rapor</span></div>
  <div class="doc"><span class="tag">${title}</span>${body}</div>
</div></body></html>`;

const ARTICLE = stagePage('Aylık Rapor', '#8957e5', `
  <h1>Ağustos ayı üretkenlik özeti</h1>
  <div class="meta">Hazırlayan: Operasyon Ekibi · 18 Ağustos 2026</div>
  <p>Bu dönemde ekip genelinde tekrarlayan işlerin süresi belirgin biçimde kısaldı.
     Panodan yapıştırma, ekran alıntısı ve metin tanıma adımları tek bir araçta
     toplandığı için uygulamalar arasında gidip gelme ihtiyacı azaldı.</p>
  <p>Aşağıdaki tabloda üç temel işin ortalama tamamlanma süreleri yer alıyor.
     Ölçümler haftalık örneklemlerin ortalamasıdır.</p>
  <table><thead><tr><th>İş adımı</th><th>Temmuz</th><th>Ağustos</th><th>Değişim</th></tr></thead>
  <tbody>
    <tr><td>Belgeden metin çıkarma</td><td class="num">4 dk 20 sn</td><td class="num">48 sn</td><td class="num">−81%</td></tr>
    <tr><td>Ekran görüntüsü paylaşma</td><td class="num">1 dk 55 sn</td><td class="num">32 sn</td><td class="num">−72%</td></tr>
    <tr><td>Sık kullanılan metni bulma</td><td class="num">1 dk 10 sn</td><td class="num">9 sn</td><td class="num">−87%</td></tr>
  </tbody></table>
  <p style="margin-top:22px">Önümüzdeki dönemde kaydırmalı yakalama özelliğinin uzun
     raporlarda kullanımı yaygınlaştırılacak.</p>`);

// Galeri küçük resimleri ve büyük görüntüleyici için birkaç farklı "ekran görüntüsü".
const SHOT_PAGES = [
    ARTICLE,
    stagePage('Sürüm Notları', '#2f81f7', `
      <h1>CopyBoard 2.11</h1><div class="meta">Değişiklik listesi</div>
      <p>Galeri küçük resimleri artık hücrenin şeklinde üretiliyor; eski kayıtlar için
         tek seferlik bir onarım geçişi eklendi.</p>
      <p>Kaydetme sırasında simgenin yerinde bir bekleme göstergesi beliriyor ve panel
         gerçekten açıldığında duruyor.</p>
      <p>Kaydırmalı yakalamada sabit başlık ve araç çubukları tanınıp sonuçta yalnızca
         bir kez görünüyor.</p>`),
    stagePage('Tasarım', '#e3651d', `
      <h1>Arayüz renk paleti</h1><div class="meta">Koyu ve açık tema karşılıkları</div>
      <p>Üç ayrı arka plan düzlemi kullanılıyor: pencere, pencere içindeki çerçeve ve
         yüzeyin kendisi. Bu ayrım listedeki satırların kenarlık olmadan da
         ayrışmasını sağlıyor.</p>
      <table><thead><tr><th>Belirteç</th><th>Koyu</th><th>Açık</th></tr></thead><tbody>
        <tr><td>bg-base</td><td>#0f0f12</td><td>#f7f7f9</td></tr>
        <tr><td>bg-raised</td><td>#16161b</td><td>#ffffff</td></tr>
        <tr><td>accent</td><td>#8957e5</td><td>#7a44dd</td></tr>
      </tbody></table>`),
    stagePage('Takvim', '#1a9c6b', `
      <h1>Haftalık plan</h1><div class="meta">18–22 Ağustos</div>
      <table><thead><tr><th>Gün</th><th>Konu</th><th>Saat</th></tr></thead><tbody>
        <tr><td>Pazartesi</td><td>Sürüm gözden geçirme</td><td class="num">10:00</td></tr>
        <tr><td>Salı</td><td>Sürüm planı</td><td class="num">14:00</td></tr>
        <tr><td>Çarşamba</td><td>Test takvimi</td><td class="num">11:30</td></tr>
        <tr><td>Perşembe</td><td>Kullanıcı görüşmeleri</td><td class="num">15:00</td></tr>
        <tr><td>Cuma</td><td>Yayın</td><td class="num">09:30</td></tr>
      </tbody></table>`),
    stagePage('Destek', '#c0392b', `
      <h1>Açık kayıtlar</h1><div class="meta">Bu hafta gelen talepler</div>
      <table><thead><tr><th>Kayıt</th><th>Konu</th><th>Durum</th></tr></thead><tbody>
        <tr><td>#4181</td><td>Kısayol çakışması</td><td>Çözüldü</td></tr>
        <tr><td>#4186</td><td>OCR dil seçimi</td><td>İnceleniyor</td></tr>
        <tr><td>#4190</td><td>Galeri sıralaması</td><td>Beklemede</td></tr>
        <tr><td>#4194</td><td>Yüzen araç konumu</td><td>Çözüldü</td></tr>
      </tbody></table>`),
    stagePage('Kılavuz', '#0f766e', `
      <h1>Kaydırmalı yakalama</h1><div class="meta">Adım adım</div>
      <p>Alanı seçip <strong>Başlat</strong>'a basın. Ardından sayfayı her zamanki gibi
         kendiniz kaydırın; kareler örtüşmelerinden birleştirilir.</p>
      <p>Kaydırmayı bıraktığınızda işlem kendiliğinden biter. Sayfayla birlikte kaymayan
         sabit başlıklar tanınır ve sonuçta yalnızca bir kez görünür.</p>
      <p>Bir kare güvenle eşleşmezse birleştirilmez; kaç karenin atlandığı sonunda
         size söylenir.</p>`),
    stagePage('Ölçüm', '#b45309', `
      <h1>Sürüm karşılaştırması</h1><div class="meta">Açılış süreleri, ortalama</div>
      <table><thead><tr><th>Sürüm</th><th>Soğuk</th><th>Sıcak</th></tr></thead><tbody>
        <tr><td>2.9.5</td><td class="num">1,84 sn</td><td class="num">0,42 sn</td></tr>
        <tr><td>2.10.0</td><td class="num">1,61 sn</td><td class="num">0,38 sn</td></tr>
        <tr><td>2.11.0</td><td class="num">1,33 sn</td><td class="num">0,31 sn</td></tr>
      </tbody></table>
      <p style="margin-top:22px">Ölçümler aynı makinede on kez tekrarlanıp
         ortalanmıştır.</p>`),
    stagePage('Bülten', '#6d28d9', `
      <h1>Ekip duyurusu</h1><div class="meta">Operasyon · 18 Ağustos</div>
      <p>Yeni sürüm bu hafta içinde tüm cihazlara dağıtılacak. Güncelleme uygulama
         açılışında kendiliğinden kontrol edilir.</p>
      <p>Kısayollarını değiştirmiş olan arkadaşların ayarları korunuyor; yeniden
         tanımlamaya gerek yok.</p>`)
];

let gallery = [];   // get-screenshots yanıtı
let stageShot = null; // { dataUrl, w, h } — yakalama katmanlarının altındaki görüntü

async function buildStage() {
    const win = mkWin({ width: STAGE_W, height: STAGE_H, backgroundColor: '#101014' });
    const shots = [];
    for (const page of SHOT_PAGES) {
        await loadHTML(win, page);
        shots.push(await win.webContents.capturePage());
    }
    win.destroy();

    const first = shots[0];
    const size = first.getSize();
    stageShot = { dataUrl: first.toDataURL(), w: size.width, h: size.height };

    gallery = shots.map((img, i) => {
        const s = img.getSize();
        return {
            id: 'shot' + i,
            timestamp: ago(i * 47 + 5),
            w: s.width, h: s.height,
            thumb: img.resize({ width: 420, quality: 'best' }).toJPEG(85)
                .toString('base64').replace(/^/, 'data:image/jpeg;base64,')
        };
    });
}

// Yakalama katmanı (snipper / OCR / video / kaydırma) — gerçek createCapture ile
// aynı pencere seçenekleri, yalnızca tam ekran yerine sabit ölçüde.
async function openCapture(file, mode) {
    const win = mkWin({
        width: STAGE_W, height: STAGE_H,
        transparent: true, hasShadow: false, resizable: false,
        webPreferences: { zoomFactor: 1.0 }
    });
    const ready = waitReady();
    await load(win, path.join(RENDERER, file));
    win.webContents.send('capture-screen', stageShot.dataUrl, mode, 'screen:0:0', 'high',
        stageShot.w, stageShot.h, false);
    await ready;
    await sleep(500);
    return win;
}

// ── Ekranlar ─────────────────────────────────────────────────────────────────

async function shotMainWindow() {
    const win = mkWin({ width: 350, height: 550, backgroundColor: '#0f0f12' });
    await load(win, path.join(RENDERER, 'main-window', 'index.html'));
    await sleep(600);

    write('01-pano-gecmisi', await onBackdrop(await win.webContents.capturePage(), 40));

    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="favorites"]').click()`);
    await sleep(400);
    write('02-favoriler', await onBackdrop(await win.webContents.capturePage(), 40));

    // Not penceresi — favorilerdeki ilk öğenin notu.
    await win.webContents.executeJavaScript(`
        (() => { const b = document.querySelector('#history-list .note-btn, #history-list [data-act="note"]');
                 if (b) b.click(); })()`).catch(() => {});
    await sleep(350);
    const noteOpen = await win.webContents.executeJavaScript(
        `!document.getElementById('note-modal').classList.contains('hidden')`).catch(() => false);
    if (noteOpen) {
        write('03-not', await onBackdrop(await win.webContents.capturePage(), 40));
        await win.webContents.executeJavaScript(
            `document.getElementById('close-note-btn').click()`).catch(() => {});
        await sleep(250);
    }

    await win.webContents.executeJavaScript(`document.getElementById('gallery-btn').click()`);
    await sleep(700);
    write('04-ekran-goruntuleri-galerisi', await onBackdrop(await win.webContents.capturePage(), 40));

    await win.webContents.executeJavaScript(`document.getElementById('back-btn').click()`);
    await sleep(300);
    await win.webContents.executeJavaScript(`document.getElementById('settings-btn').click()`);
    await sleep(500);
    write('05-ayarlar', await onBackdrop(await win.webContents.capturePage(), 40));

    await win.webContents.executeJavaScript(`document.getElementById('shortcuts-toggle').click()`);
    await sleep(450);
    // Kartın başlığından itibaren göster — yarısı kesik bir satırla başlamasın.
    await win.webContents.executeJavaScript(
        `document.getElementById('shortcuts-toggle').scrollIntoView({ block: 'start' })`);
    await sleep(350);
    write('06-kisayol-ayarlari', await onBackdrop(await win.webContents.capturePage(), 40));

    win.destroy();
}

async function shotLightTheme() {
    THEME = 'light';
    const win = mkWin({ width: 350, height: 550, backgroundColor: '#f7f7f9' });
    await load(win, path.join(RENDERER, 'main-window', 'index.html'));
    await sleep(600);
    write('07-acik-tema', await onBackdrop(await win.webContents.capturePage(), 40, LIGHT_BACKDROP));
    win.destroy();
    THEME = 'dark';
}

async function shotSnipper() {
    const win = await openCapture(path.join('snipper', 'snipper.html'), 'draw');
    const up = await drag(win, { x: 210, y: 150 }, { x: 1120, y: 700 });
    await up();
    await sleep(400);
    write('08-ekran-alintisi', await win.webContents.capturePage());
    win.destroy();
}

async function shotOcr() {
    const win = await openCapture(path.join('ocr', 'ocr.html'), 'ocr');
    // Fareyi bırakmıyoruz: bırakınca seçim OCR'a gidip katman kapanır.
    await drag(win, { x: 260, y: 300 }, { x: 1030, y: 560 });
    await sleep(300);
    write('09-ocr', await win.webContents.capturePage());
    win.destroy();
}

async function shotColorPicker() {
    const win = await openCapture(path.join('snipper', 'snipper.html'), 'color');
    // Büyütecin altında renkli bir şey olsun: sahnedeki mor etiketin ortası. Boş bir
    // paragrafın üstünde durunca ekran "#ffffff" okuyor ve aracın ne yaptığı anlaşılmıyor.
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 259, y: 175 });
    await sleep(500);
    write('10-renk-secici', await win.webContents.capturePage());
    win.destroy();
}

async function shotRecorder() {
    const win = await openCapture(path.join('recorder', 'recorder.html'), 'video');
    const up = await drag(win, { x: 190, y: 140 }, { x: 1150, y: 720 });
    await up();
    await sleep(500);
    write('11-video-kaydi', await win.webContents.capturePage());
    win.destroy();
}

async function shotScroller() {
    const win = await openCapture(path.join('scroller', 'scroller.html'), 'scroll');
    const up = await drag(win, { x: 250, y: 170 }, { x: 1090, y: 690 });
    await up();
    await sleep(500);
    write('12-kaydirmali-yakalama', await win.webContents.capturePage());
    win.destroy();
}

async function shotViewer() {
    const win = mkWin({ width: 1100, height: 760, backgroundColor: '#1c1c1e' });
    await load(win, path.join(RENDERER, 'viewer', 'viewer.html'));
    win.webContents.send('viewer-list', gallery.map((s) => ({ id: s.id, thumb: s.thumb })));
    win.webContents.send('viewer-image', {
        id: gallery[0].id, dataUrl: stageShot.dataUrl, size: 480000,
        w: gallery[0].w, h: gallery[0].h, timestamp: gallery[0].timestamp,
        pos: 1, total: gallery.length
    });
    await sleep(900);
    write('13-goruntuleyici', await win.webContents.capturePage());
    win.destroy();
}

async function shotWidget() {
    // Açık haldeki ölçüler (window-manager: FULL_W 418, EXP_H 404). Gerçek uygulamada
    // pencereyi ana süreç büyütür; burada baştan o boyda açıyoruz.
    const win = mkWin({ width: 418, height: 404, transparent: true, hasShadow: false });
    await load(win, path.join(RENDERER, 'widget', 'widget.html'));
    win.webContents.send('widget-side', 'right');
    win.webContents.send('widget-config', { transparent: false, color: '#8957e5', opacity: 100 });
    await sleep(300);

    // Widget dairesel bir isabet testi yapıyor: sentetik click() clientX/Y=0 ile gelir
    // ve düğmenin dışında sayılır. Gerçek fare olayı şart.
    const center = (sel) => win.webContents.executeJavaScript(
        `(() => { const r = document.querySelector('${sel}').getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);

    let p = await center('#widget-main');
    await click(win, p.x, p.y);
    await sleep(700);
    // Pencerenin solundaki 350px, kapalı duran pano paneline ayrılmış saydam boşluk.
    // Menü tek başına çekilirken o boşluk kadrajın yarısını yer.
    const col = await win.webContents.executeJavaScript(`(() => {
        const els = [document.getElementById('widget-main'),
                     ...document.querySelectorAll('#widget-menu .menu-item')];
        const r = els.map((e) => e.getBoundingClientRect());
        const x = Math.min(...r.map((b) => b.left)), y = Math.min(...r.map((b) => b.top));
        return { x, y, w: Math.max(...r.map((b) => b.right)) - x,
                 h: Math.max(...r.map((b) => b.bottom)) - y };
    })()`);
    write('14-yuzen-arac', await onBackdrop(cropDip(await win.webContents.capturePage(), col, 14), 44));

    p = await center('#btn-snippet');
    await click(win, p.x, p.y);
    await sleep(900);
    write('15-yuzen-arac-pano', await onBackdrop(await win.webContents.capturePage(), 44));
    win.destroy();
}

async function shotQuickPaste() {
    const win = mkWin({ width: 300, height: 380, transparent: true, hasShadow: false });
    await load(win, path.join(RENDERER, 'quickpaste', 'quickpaste.html'));
    win.webContents.send('quickpaste-show', { count: 20 });
    await sleep(700);
    write('16-hizli-yapistir', await onBackdrop(await win.webContents.capturePage(), 44));
    win.destroy();
}

async function shotUpdateDialog() {
    const win = mkWin({ width: 380, height: 500, transparent: true });
    await load(win, path.join(RENDERER, 'update', 'update-dialog.html'));
    win.webContents.send('update-info', {
        currentVersion: SETTINGS.appVersion,
        version: '2.12.0',
        isMac: process.platform === 'darwin',
        // GitHub sürüm notlarını HTML olarak verir; pencere de markdown değil HTML
        // temizleyip basar.
        releaseNotes: '<h3>Yenilikler</h3><ul>'
            + '<li>Kaydırmalı yakalamada sabit başlık ve altlık algılama</li>'
            + '<li>Galeri küçük resimleri hücrenin şeklinde üretiliyor</li>'
            + '<li>Kaydetme sırasında bekleme göstergesi</li></ul>'
            + '<h3>Düzeltmeler</h3><ul>'
            + '<li>İlk küçük resim sürekli üzerine gelinmiş gibi görünüyordu</li>'
            + '<li>Galeri küçük resimleri Retina ekranda büyütülüyordu</li></ul>'
    });
    await sleep(600);
    write('17-guncelleme', await onBackdrop(await win.webContents.capturePage(), 44));
    win.destroy();
}

async function shotToast() {
    const win = mkWin({ width: 320, height: 100, transparent: true });
    await load(win, path.join(RENDERER, 'toast', 'toast.html'));
    win.webContents.send('display-toast', 'Metin panoya kopyalandı', 'success');
    await sleep(600);
    write('18-bildirim', await onBackdrop(await win.webContents.capturePage(), 36));
    win.destroy();
}

// ── Sıra ─────────────────────────────────────────────────────────────────────

// Her ekran arasında pencere sayısı sıfıra düşüyor; varsayılan davranış uygulamayı
// orada kapatırdı.
app.on('window-all-closed', () => { });

app.whenReady().then(async () => {
    // Sıfırdan yaz: ekran adları değiştiğinde eski dosyalar klasörde kalmasın.
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    registerStubs();

    console.log(`Ölçek: ${screen.getPrimaryDisplay().scaleFactor}x → ${OUT}`);
    console.log('Sahne hazırlanıyor…');
    await buildStage();

    const steps = [
        ['Ana pencere', shotMainWindow],
        ['Açık tema', shotLightTheme],
        ['Ekran alıntısı', shotSnipper],
        ['OCR', shotOcr],
        ['Renk seçici', shotColorPicker],
        ['Video kaydı', shotRecorder],
        ['Kaydırmalı yakalama', shotScroller],
        ['Görüntüleyici', shotViewer],
        ['Yüzen araç', shotWidget],
        ['Hızlı yapıştır', shotQuickPaste],
        ['Güncelleme', shotUpdateDialog],
        ['Bildirim', shotToast]
    ];

    // Klasör en başta silindiği için yarım kalan bir koşu README'yi kırık görsellerle
    // bırakır. Sessizce "başarılı" dönmek, o commit'in fark edilmeden atılması demek.
    const failed = [];
    for (const [label, fn] of steps) {
        console.log(label + '…');
        try { await fn(); } catch (e) { failed.push(label); console.error(`  ✗ ${label}: ${e.message}`); }
    }

    if (failed.length) {
        console.error(`\nEksik kaldı (${failed.length}): ${failed.join(', ')}`);
        console.error('docs/screenshots eksik — README görselleri kırık olur, commit etmeyin.');
        app.exit(1);
        return;
    }

    console.log('Bitti.');
    app.exit(0);
});
