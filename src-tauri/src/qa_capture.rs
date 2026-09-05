//! `--qa-capture`: FARE gerektiren yakalama akışlarının uçtan uca sınanması.
//!
//! ## Neden ayrı bir harness
//!
//! [`qa`](crate::qa) komut katmanını sınıyor: pencere açıldı mı, durum bayrağı
//! düştü mü, akış bırakıldı mı. Bölge seçimi, renk seçici, OCR ve kaydırmalı
//! yakalamada asıl soru bu değil — "kullanıcının SÜRÜKLEDİĞİ dikdörtgen ile
//! panoya düşen pikseller aynı yer mi?" sorusu. Bunu pencere durumundan okumak
//! mümkün değil; ekranda BİLİNEN bir desen olup çıktının PİKSELLERİ okunmalı.
//!
//! Bu, video kaydında öğrenilen dersin aynısı: kare sayısı, çözünürlük ve süre
//! doğruyken görüntünün yarısı yeşildi. Ölçülmeyen şey bozulabiliyor.
//!
//! ## Nasıl
//!
//! Ana pencereye bir "sınama kartı" basılıyor: üstte OCR için büyük metin şeridi,
//! altında dört çeyrek (kırmızı, yeşil, mavi, sarı). Kart monitörün BİLİNEN bir
//! noktasına konuyor, dolayısıyla overlay'deki CSS koordinatı da biliniyor. Sonra
//! gerçek `MouseEvent`ler gönderiliyor — sentetik olsalar da uygulamanın kendi
//! dinleyicilerinden geçiyorlar, taklit bir köprüden değil — ve sonuç PANODAN
//! geri okunuyor.
//!
//! Renklerde EŞİTLİK değil İLİŞKİ sınanıyor: ekran yakalama ekranın renk
//! uzayından geçiyor, `#cc0000` birebir geri gelmiyor. Kanıtlanan şey GEOMETRİ —
//! kırpma bir çeyrek kaysa ya da eksen devrilse çeyrek renkleri yer değiştirirdi.
//!
//! Yalnız `debug_assertions` altında derleniyor.

#![cfg(debug_assertions)]

use std::collections::HashMap;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::geom::MonitorInfo;
use crate::state::AppState;

// ── Renderer → Rust değer kanalı ───────────────────────────────────────────
// Tauri'de `eval` bir değer DÖNDÜRMÜYOR. Renderer, zaten var olan
// `sendDebugLog` üzerinden `QAC anahtar=değer` yazıyor; `commands::core::debug_log`
// bunu buraya veriyor. Yeni bir komut açmaya gerek yok — sürüm derlemesinde bu
// yolun tamamı derlenmiyor.
static PROBES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn probes() -> &'static Mutex<HashMap<String, String>> {
    PROBES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `debug_log` çağırıyor: `anahtar=değer`.
pub fn probe(line: &str) {
    if let Some((k, v)) = line.split_once('=') {
        probes().lock().unwrap().insert(k.trim().to_string(), v.to_string());
    }
}

fn take_probe(key: &str) -> Option<String> {
    probes().lock().unwrap().remove(key)
}

fn clear_probes() {
    probes().lock().unwrap().clear();
}

/// Renderer'ın değeri yazmasını bekler. `eval` eşzamansız — beklemeden okumak
/// bir öncekinin bayat değerini görürdü.
fn wait_probe(key: &str, ms: u64) -> Option<String> {
    let until = Instant::now() + Duration::from_millis(ms);
    loop {
        if let Some(v) = take_probe(key) {
            return Some(v);
        }
        if Instant::now() >= until {
            return None;
        }
        sleep(50);
    }
}

// ── Yardımcılar ────────────────────────────────────────────────────────────

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&tauri::AppHandle) -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    let h = app.clone();
    if app.run_on_main_thread(move || { let _ = tx.send(f(&h)); }).is_err() {
        return None;
    }
    rx.recv_timeout(Duration::from_secs(8)).ok()
}

/// Sayaç: kaç adım düştü.
static FAILS: Mutex<u32> = Mutex::new(0);

fn check(ok: bool, what: &str) -> bool {
    if ok {
        log::info!("QAC ✓ {what}");
        println!("QAC ✓ {what}");
    } else {
        *FAILS.lock().unwrap() += 1;
        log::error!("QAC ✗ {what}");
        println!("QAC ✗ {what}");
    }
    ok
}

fn note(what: &str) {
    log::info!("QAC · {what}");
    println!("QAC · {what}");
}

fn eval(app: &tauri::AppHandle, label: &str, js: String) {
    let l = label.to_string();
    on_main(app, move |h| {
        if let Some(w) = h.get_webview_window(&l) {
            if let Err(e) = w.eval(js.as_str()) {
                log::warn!("QAC eval({l}) hata: {e}");
            }
        } else {
            log::warn!("QAC eval: {l} penceresi yok");
        }
    });
}

fn visible(app: &tauri::AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Overlay açılıp ekran görüntüsünü boyayana kadar bekler.
fn wait_overlay(app: &tauri::AppHandle, label: &str) -> bool {
    for _ in 0..60 {
        sleep(100);
        if visible(app, label) {
            sleep(400); // boyama + `ready` sınıfı otursun
            return true;
        }
    }
    false
}

// ── Sınama kartı ───────────────────────────────────────────────────────────

/// Kartın çeyrek renkleri. Renk uzayı dönüşümünü kaldırabilecek kadar ayrık
/// seçildi; sınanan şey hangi çeyreğin NEREDE olduğu.
const C_TL: &str = "#cc0000"; // kırmızı
const C_TR: &str = "#00aa44"; // yeşil
const C_BL: &str = "#0044cc"; // mavi
const C_BR: &str = "#ddaa00"; // sarı

/// OCR şeridindeki damga. Ekranda başka hiçbir yerde geçmeyecek iki kelime.
const OCR_MARK_A: &str = "ZEBRA";
const OCR_MARK_B: &str = "QUARTZ";

struct Card {
    /// Kartın overlay CSS koordinatındaki sol üst köşesi.
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    /// Üstteki OCR metin şeridinin yüksekliği.
    band: f64,
}

impl Card {
    /// Çeyreklerin kapladığı blok (metin şeridinin altı), kenarlardan içeri alınmış.
    fn quads_rect(&self, inset: f64) -> (f64, f64, f64, f64) {
        (
            self.x + inset,
            self.y + self.band + inset,
            self.w - 2.0 * inset,
            self.h - self.band - 2.0 * inset,
        )
    }
    fn band_rect(&self, inset: f64) -> (f64, f64, f64, f64) {
        (self.x + inset, self.y + inset, self.w - 2.0 * inset, self.band - 2.0 * inset)
    }
    /// Sol üst çeyreğin merkezi.
    fn tl_center(&self) -> (f64, f64) {
        (self.x + self.w * 0.25, self.y + self.band + (self.h - self.band) * 0.25)
    }
}

/// Ana pencereyi bilinen bir dikdörtgene oturtup içine kartı basar.
fn install_card(app: &tauri::AppHandle, m: &MonitorInfo, kind: &str) -> Option<Card> {
    // Odak kaybında gizlenme kapalı: overlay odağı alınca kart ekrandan silinirdi.
    crate::windows::main_window::UI_TEST_KEEP_VISIBLE
        .store(true, std::sync::atomic::Ordering::Release);

    let w = 600.0_f64.min(m.work_width - 80.0);
    let h = 600.0_f64.min(m.work_height - 80.0);
    let gx = m.work_x + 40.0;
    let gy = m.work_y + 40.0;

    // SIRA: önce göster, sonra konumlandır (gizli pencereye `set_position` macOS'ta
    // sessizce kayboluyor — bkz. `geom::place`).
    on_main(app, crate::windows::main_window::show)?;
    sleep(500);
    let placed = on_main(app, move |h2| {
        h2.get_webview_window(crate::windows::main_window::LABEL)
            .map(|win| crate::geom::place(&win, gx, gy, w, h).is_ok())
            .unwrap_or(false)
    })?;
    if !placed {
        return None;
    }
    sleep(400);

    let band = (h * 0.2).round();
    let js = card_js(kind, band);
    eval(app, crate::windows::main_window::LABEL, js);
    sleep(600); // yerleşim + boyama

    Some(Card { x: gx - m.x, y: gy - m.y, w, h, band })
}

fn card_js(kind: &str, band: f64) -> String {
    // Şablon + `replace`: `format!` kullanılsaydı JS'teki her `{` ikilenecekti.
    const TPL: &str = r#"(function(){
  if(!document.body){document.documentElement.appendChild(document.createElement('body'));}
  document.body.style.margin='0';
  document.getElementById('qa-card')?.remove();
  const d = document.createElement('div');
  d.id = 'qa-card';
  d.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:#ffffff;display:flex;flex-direction:column;overflow:hidden';
  const band = document.createElement('div');
  band.id = 'qa-band';
  band.style.cssText = 'flex:0 0 __BAND__px;background:#ffffff;color:#000000;display:flex;align-items:center;justify-content:center;font-family:Helvetica,Arial,sans-serif;font-weight:700;letter-spacing:1px;white-space:nowrap';
  band.style.fontSize = Math.round(__BAND__ * 0.34) + 'px';
  band.textContent = '__MARK_A__ __MARK_B__';
  d.appendChild(band);
  const body = document.createElement('div');
  body.id = 'qa-body';
  body.style.cssText = 'flex:1 1 auto;position:relative;overflow:hidden';
  if ('__KIND__' === 'scroll') {
    // Kaydırma sınaması: her satırın YATAY profili farklı olmalı, yoksa birleştirici
    // hangi satırın yeni olduğunu ayırt edemez (128 sütuna indirgeyip karşılaştırıyor).
    const list = document.createElement('div');
    list.id = 'qa-scroll';
    list.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;background:#ffffff';
    let html = '';
    for (let i = 0; i < 400; i++) {
      const wpc = 12 + ((i * 37) % 83);
      const shade = i % 2 ? '#f2f2f2' : '#ffffff';
      html += '<div style="height:28px;background:' + shade + ';display:flex;align-items:center;font:600 14px Helvetica,Arial;color:#111">'
           +  '<span style="width:64px;flex:none;padding-left:8px">' + i + '</span>'
           +  '<span style="height:14px;background:#1c1c1c;width:' + wpc + '%"></span></div>';
    }
    list.innerHTML = html;
    body.appendChild(list);
  } else {
    const grid = document.createElement('div');
    grid.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr';
    ['__C_TL__','__C_TR__','__C_BL__','__C_BR__'].forEach(c => {
      const q = document.createElement('div');
      q.style.background = c;
      grid.appendChild(q);
    });
    body.appendChild(grid);
  }
  d.appendChild(body);
  document.body.appendChild(d);
})();"#;
    TPL.replace("__BAND__", &format!("{band:.0}"))
        .replace("__KIND__", kind)
        .replace("__MARK_A__", OCR_MARK_A)
        .replace("__MARK_B__", OCR_MARK_B)
        .replace("__C_TL__", C_TL)
        .replace("__C_TR__", C_TR)
        .replace("__C_BL__", C_BL)
        .replace("__C_BR__", C_BR)
}

/// Kaydırma sınaması için AYRI bir pencere.
///
/// Neden ana pencere kullanılamıyor: `scroll_begin`, akıştan başlığında "CopyBoard"
/// geçen TÜM pencereleri dışlıyor (`record.rs`, `Some("CopyBoard")`) ve uygulamanın
/// her penceresinin başlığı "CopyBoard" — yani CopyBoard kendi arayüzünü kaydırmalı
/// olarak yakalayamıyor. Bu bilinçli bir ürün kararı (overlay'in kendisi filme
/// girmesin), ama sınama kartını da görünmez yapıyor.
///
/// Bu yüzden hedef, başlığı FARKLI olan gerçek bir pencere: ekranda gerçekten
/// duruyor, gerçek WKWebView boyuyor ve akışa gerçek ScreenCaptureKit üzerinden
/// giriyor. Kullanıcının senaryosundan tek farkı pencerenin sahibi.
fn open_scroll_target(app: &tauri::AppHandle, m: &MonitorInfo) -> Option<Card> {
    let w = 600.0_f64.min(m.work_width - 80.0);
    let h = 600.0_f64.min(m.work_height - 80.0);
    let gx = m.work_x + 40.0;
    let gy = m.work_y + 40.0;
    let band = (h * 0.2).round();

    let built = on_main(app, move |h2| {
        // Var olmayan bir varlık yolu: boş bir belge açılıyor ve içerik `eval` ile
        // basılıyor. Böylece ne ürüne bir sayfa ekleniyor ne de sınama uygulamanın
        // kendi scriptlerinden birini çalıştırıyor (`data:` URL'i Tauri'nin
        // `webview-data-url` özelliğini gerektiriyordu — sürüm derlemesini sınama
        // uğruna genişletmemek için o yol seçilmedi).
        tauri::WebviewWindowBuilder::new(h2, "qa-scroll-target", tauri::WebviewUrl::App("qa-blank.html".into()))
            .title("Kaydirma Sinama Penceresi")
            .inner_size(w, h)
            .position(gx, gy)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible(true)
            .build()
            .map_err(|e| log::error!("QAC kaydırma hedefi kurulamadı: {e}"))
            .ok()
            .map(|_| ())
    })?;
    built?;
    sleep(700);
    eval(app, "qa-scroll-target", card_js("scroll", band));
    sleep(700);
    Some(Card { x: gx - m.x, y: gy - m.y, w, h, band })
}

fn close_scroll_target(app: &tauri::AppHandle) {
    on_main(app, |h| {
        if let Some(w) = h.get_webview_window("qa-scroll-target") {
            let _ = w.close();
        }
    });
    sleep(300);
}

fn remove_card(app: &tauri::AppHandle) {
    eval(
        app,
        crate::windows::main_window::LABEL,
        "document.getElementById('qa-card')?.remove();".to_string(),
    );
    sleep(200);
    crate::windows::main_window::UI_TEST_KEEP_VISIBLE
        .store(false, std::sync::atomic::Ordering::Release);
    on_main(app, crate::windows::main_window::hide);
}

// ── Sentetik fare ──────────────────────────────────────────────────────────

/// Sürükleme. Olaylar `document.body`'ye gönderiliyor ve `window`'a KABARIYOR:
/// dinleyiciler `window`'da ama `e.target.closest(...)` çağırıyorlar, yani hedef
/// bir Element olmak zorunda (window'un `closest`i yok).
fn drag_js(x1: f64, y1: f64, x2: f64, y2: f64, steps: u32) -> String {
    const TPL: &str = r#"(function(){
  const ev=(t,x,y)=>document.body.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:1}));
  const x1=__X1__, y1=__Y1__, x2=__X2__, y2=__Y2__, n=__N__;
  ev('mousedown',x1,y1);
  for(let i=1;i<=n;i++){ ev('mousemove', x1+(x2-x1)*i/n, y1+(y2-y1)*i/n); }
  ev('mouseup',x2,y2);
})();"#;
    TPL.replace("__X1__", &format!("{x1:.1}"))
        .replace("__Y1__", &format!("{y1:.1}"))
        .replace("__X2__", &format!("{x2:.1}"))
        .replace("__Y2__", &format!("{y2:.1}"))
        .replace("__N__", &steps.to_string())
}

fn click_js(x: f64, y: f64) -> String {
    const TPL: &str = r#"(function(){
  const ev=(t,x,y)=>document.body.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}));
  ev('mousemove',__X__,__Y__); ev('mousedown',__X__,__Y__); ev('mouseup',__X__,__Y__);
})();"#;
    TPL.replace("__X__", &format!("{x:.1}")).replace("__Y__", &format!("{y:.1}"))
}

/// Araç çubuğu düğmeleri `click` DEĞİL `mousedown` dinliyor — `.click()` çağırmak
/// hiçbir şey yapmazdı ve test sahte bir yeşil verirdi.
fn press_js(id: &str) -> String {
    format!(
        "document.getElementById('{id}')?.dispatchEvent(new MouseEvent('mousedown',{{bubbles:true,cancelable:true,button:0}}));"
    )
}

// ── Pano ───────────────────────────────────────────────────────────────────

struct Img {
    w: usize,
    h: usize,
    rgba: Vec<u8>,
}

fn clipboard_image() -> Option<Img> {
    let img = arboard::Clipboard::new().ok()?.get_image().ok()?;
    Some(Img { w: img.width, h: img.height, rgba: img.bytes.into_owned() })
}

/// Panodaki resmi, göreli merkez etrafında küçük bir kutuda ortalar.
fn sample(img: &Img, rx: f64, ry: f64) -> (f64, f64, f64) {
    let bw = ((img.w as f64) * 0.06).max(2.0) as usize;
    let bh = ((img.h as f64) * 0.06).max(2.0) as usize;
    let cx = ((img.w as f64) * rx) as usize;
    let cy = ((img.h as f64) * ry) as usize;
    let x0 = cx.saturating_sub(bw / 2);
    let y0 = cy.saturating_sub(bh / 2);
    let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
    for y in y0..(y0 + bh).min(img.h) {
        for x in x0..(x0 + bw).min(img.w) {
            let i = (y * img.w + x) * 4;
            if i + 2 >= img.rgba.len() {
                continue;
            }
            r += img.rgba[i] as u64;
            g += img.rgba[i + 1] as u64;
            b += img.rgba[i + 2] as u64;
            n += 1;
        }
    }
    if n == 0 {
        return (0.0, 0.0, 0.0);
    }
    (r as f64 / n as f64, g as f64 / n as f64, b as f64 / n as f64)
}

fn hex_of(c: (f64, f64, f64)) -> String {
    format!("#{:02x}{:02x}{:02x}", c.0 as u8, c.1 as u8, c.2 as u8)
}

/// Verilen dikdörtgende KIRMIZI sayılabilecek piksel sayısı. Açıklama kaleminin
/// varsayılan rengi `#ff3b30`; ekranın renk uzayından geçtikten sonra da tek başına
/// kırmızı kalıyor, o yüzden eşik gevşek tutuldu.
fn count_red(img: &Img, x0: usize, y0: usize, x1: usize, y1: usize) -> usize {
    let mut n = 0;
    for y in y0..y1.min(img.h) {
        for x in x0..x1.min(img.w) {
            let i = (y * img.w + x) * 4;
            if i + 2 >= img.rgba.len() {
                continue;
            }
            let (r, g, b) = (img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]);
            if r > 150 && g < 110 && b < 110 {
                n += 1;
            }
        }
    }
    n
}

// ── Akışlar ────────────────────────────────────────────────────────────────

/// 1. Bölge seçimi: sürükle → Kopyala → panodaki piksellere bak.
fn flow_snip(app: &tauri::AppHandle, m: &MonitorInfo, index: usize) {
    if index == 0 {
        note("— bölge seçimi (sürükle, kırp, kopyala) —");
    } else {
        note(&format!("— bölge seçimi, MONİTÖR {index} —"));
    }
    let label = format!("capture-{index}");
    let Some(card) = install_card(app, m, "colors") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };

    let before: Vec<String> = gallery_ids(app);

    on_main(app, |h| crate::capture::start(h, "draw"));
    if !check(wait_overlay(app, &label), &format!("seçim overlay'i açıldı ({label})")) {
        remove_card(app);
        return;
    }

    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    clear_probes();
    eval(app, &label, drag_js(qx, qy, qx + qw, qy + qh, 24));
    sleep(400);

    // Seçim GERÇEKTEN istenen yere mi oturdu, ve sürükleme bir metin seçimi
    // başlattı mı? İkincisi kullanıcının bildirdiği "ekranın diğer yerleri mavi
    // olup sönüyor" hatasının imzası.
    const READ: &str = r#"(function(){
  const r = state.selectionRect || {x:-1,y:-1,w:-1,h:-1};
  const sel = (window.getSelection && window.getSelection().toString()) || '';
  window.api.sendDebugLog('QAC snip.rect=' + [r.x,r.y,r.w,r.h].map(v=>Math.round(v)).join(','));
  window.api.sendDebugLog('QAC snip.scale=' + state.scaleX + ',' + state.scaleY);
  window.api.sendDebugLog('QAC snip.textsel=' + sel.length);
  window.api.sendDebugLog('QAC snip.toolbar=' + (getComputedStyle(document.getElementById('toolbar')).display));
})();"#;
    eval(app, &label, READ.to_string());

    let rect = wait_probe("snip.rect", 3000).unwrap_or_default();
    let scale = wait_probe("snip.scale", 1500).unwrap_or_default();
    let textsel = wait_probe("snip.textsel", 1500).unwrap_or_default();
    let toolbar = wait_probe("snip.toolbar", 1500).unwrap_or_default();
    note(&format!("seçim={rect} ölçek={scale} metinSeçimi={textsel} araçÇubuğu={toolbar}"));

    let got: Vec<f64> = rect.split(',').filter_map(|v| v.parse().ok()).collect();
    let want = [qx, qy, qw, qh];
    let rect_ok = got.len() == 4 && got.iter().zip(want.iter()).all(|(a, b)| (a - b).abs() <= 2.0);
    check(rect_ok, &format!("seçim dikdörtgeni sürüklenen yere oturdu (istenen {want:?}, olan {got:?})"));
    check(textsel == "0", "sürükleme metin seçimi başlatmadı (mavi yanıp sönme hatası)");
    check(toolbar == "flex", "bırakınca araç çubuğu belirdi");

    // Kopyala — düğme `mousedown` dinliyor.
    let sx: f64 = scale.split(',').next().and_then(|v| v.parse().ok()).unwrap_or(m.scale);
    let sy: f64 = scale.split(',').nth(1).and_then(|v| v.parse().ok()).unwrap_or(m.scale);
    eval(app, &label, press_js("btn-copy"));
    sleep(1800);

    let Some(img) = on_main(app, |_| clipboard_image()).flatten() else {
        check(false, "Kopyala sonrası panoda resim yok");
        remove_card(app);
        return;
    };
    let want_w = (qw * sx).round() as usize;
    let want_h = (qh * sy).round() as usize;
    check(
        img.w.abs_diff(want_w) <= 2 && img.h.abs_diff(want_h) <= 2,
        &format!("pano resmi seçimin fiziksel boyutunda ({}x{}, beklenen {want_w}x{want_h})", img.w, img.h),
    );

    // Dört çeyrek: hangi renk NEREDE. Kırpma kaysa ya da eksenler devrilse burada
    // çöker — video kaydındaki yeşil yarım tam olarak böyle bir hataydı.
    let tl = sample(&img, 0.25, 0.25);
    let tr = sample(&img, 0.75, 0.25);
    let bl = sample(&img, 0.25, 0.75);
    let br = sample(&img, 0.75, 0.75);
    note(&format!(
        "çeyrekler: SolÜst={} SağÜst={} SolAlt={} SağAlt={}",
        hex_of(tl), hex_of(tr), hex_of(bl), hex_of(br)
    ));
    check(tl.0 > tl.1 + 40.0 && tl.0 > tl.2 + 40.0, "sol üst çeyrek KIRMIZI");
    check(tr.1 > tr.0 + 40.0 && tr.1 > tr.2 + 40.0, "sağ üst çeyrek YEŞİL");
    check(bl.2 > bl.0 + 40.0 && bl.2 > bl.1 + 40.0, "sol alt çeyrek MAVİ");
    check(br.0 > br.2 + 60.0 && br.1 > br.2 + 60.0, "sağ alt çeyrek SARI");

    // Galeriye de düşmüş olmalı: kopyalama yolu galeriyi de besliyor.
    sleep(600);
    let after = gallery_ids(app);
    let new_ids: Vec<String> = after.iter().filter(|i| !before.contains(i)).cloned().collect();
    check(new_ids.len() == 1, &format!("kopyalanan görüntü galeriye eklendi ({} yeni kayıt)", new_ids.len()));
    for id in &new_ids {
        let id = id.clone();
        on_main(app, move |h| crate::gallery::delete(h, &id));
    }

    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(500);
    check(!visible(app, &label), "kopyalama sonrası overlay kapandı");
    remove_card(app);
}

/// Açıklama araçları: kalemle çiz → çizginin panodaki görüntüde OLDUĞUNU gör.
///
/// Araç düğmeleri `click` dinliyor (araç çubuğunun Kopyala/Kaydet düğmeleri ise
/// `mousedown`) — ikisi aynı sanılıp yanlış olay gönderilseydi test sessizce
/// yeşil verirdi.
fn flow_tools(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— açıklama araçları (kalem) —");
    let Some(card) = install_card(app, m, "colors") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };
    let before = gallery_ids(app);

    on_main(app, |h| crate::capture::start(h, "draw"));
    if !check(wait_overlay(app, "capture-0"), "seçim overlay'i açıldı") {
        remove_card(app);
        return;
    }

    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    eval(app, "capture-0", drag_js(qx, qy, qx + qw, qy + qh, 20));
    sleep(400);

    // Kalemi seç ve etkin olduğunu doğrula.
    clear_probes();
    eval(
        app,
        "capture-0",
        r#"(function(){
  document.querySelector('.tool-btn[data-tool="pen"]').click();
  window.api.sendDebugLog('QAC tool.active=' + (state.activeTool || 'yok'));
})();"#
            .to_string(),
    );
    let active = wait_probe("tool.active", 2500).unwrap_or_default();
    check(active == "pen", &format!("kalem aracı etkinleşti (okunan: {active})"));

    // MAVİ çeyreğin ortasından yatay bir çizgi. Kırmızı orada olmalı; yeşil
    // çeyrekte olmamalı — çizim seçime ve çizilen yere hapsedilmiş olmalı.
    let sy_line = qy + qh * 0.75;
    eval(
        app,
        "capture-0",
        drag_js(qx + 24.0, sy_line, qx + qw * 0.5 - 24.0, sy_line, 20),
    );
    sleep(400);

    eval(app, "capture-0", press_js("btn-copy"));
    sleep(1800);

    match on_main(app, |_| clipboard_image()).flatten() {
        Some(img) => {
            let (hw, hh) = (img.w / 2, img.h / 2);
            let drawn = count_red(&img, 0, hh, hw, img.h);
            let clean = count_red(&img, hw, 0, img.w, hh);
            note(&format!("kırmızı piksel: çizilen çeyrek={drawn}, dokunulmayan çeyrek={clean}"));
            check(drawn > 500, "kalem darbesi kopyalanan görüntüde duruyor");
            check(clean < 50, "çizim dokunulmayan çeyreğe taşmadı");
        }
        None => {
            check(false, "kalem sonrası panoda resim yok");
        }
    }

    sleep(600);
    for id in gallery_ids(app).iter().filter(|i| !before.contains(i)) {
        let id = id.clone();
        on_main(app, move |h| crate::gallery::delete(h, &id));
    }
    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(400);
    remove_card(app);
}

/// 2. Renk seçici: bilinen bir çeyreğe tıkla → panoya doğru hex düşsün.
fn flow_color(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— renk seçici —");
    let Some(card) = install_card(app, m, "colors") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };

    on_main(app, |h| crate::capture::start(h, "color"));
    if !check(wait_overlay(app, "capture-0"), "renk seçici overlay'i açıldı") {
        remove_card(app);
        return;
    }

    let (cx, cy) = card.tl_center();
    eval(app, "capture-0", click_js(cx, cy));
    sleep(1500);

    let got = on_main(app, |_| crate::platform::clipboard_read_text()).flatten().unwrap_or_default();
    note(&format!("panodaki renk: {got:?} (kart değeri {C_TL})"));
    let valid = got.len() == 7 && got.starts_with('#') && got[1..].bytes().all(|c| c.is_ascii_hexdigit());
    check(valid, "panoya geçerli bir hex kodu yazıldı");
    if valid {
        let r = u8::from_str_radix(&got[1..3], 16).unwrap_or(0) as f64;
        let g = u8::from_str_radix(&got[3..5], 16).unwrap_or(0) as f64;
        let b = u8::from_str_radix(&got[5..7], 16).unwrap_or(0) as f64;
        check(r > g + 40.0 && r > b + 40.0, &format!("tıklanan pikselin rengi KIRMIZI ({got})"));
    }

    // Renk kodu geçmişe de yazılıyor — sonra temizleniyor.
    sleep(400);
    delete_history_where(app, |c| c == got);
    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(400);
    check(!visible(app, "capture-0"), "renk seçimi sonrası overlay kapandı");
    remove_card(app);
}

/// 3. OCR: metin şeridini seç → panoya damga metni düşsün.
fn flow_ocr(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— OCR (metin tanıma) —");
    let Some(card) = install_card(app, m, "colors") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };

    // Panoyu bilinen bir değere çek ki "değişti mi" ölçülebilsin.
    on_main(app, |_| crate::platform::clipboard_write_text("qac-ocr-bekliyor"));
    sleep(300);

    on_main(app, |h| crate::capture::start(h, "ocr"));
    if !check(wait_overlay(app, "capture-0"), "OCR overlay'i açıldı") {
        remove_card(app);
        return;
    }

    let (bx, by, bw, bh) = card.band_rect(6.0);
    // OCR'de `mouseup` doğrudan taramayı başlatıyor — ayrı bir düğme yok.
    eval(app, "capture-0", drag_js(bx, by, bx + bw, by + bh, 16));

    let mut got = String::new();
    for _ in 0..80 {
        sleep(250);
        got = on_main(app, |_| crate::platform::clipboard_read_text()).flatten().unwrap_or_default();
        if got != "qac-ocr-bekliyor" && !got.is_empty() {
            break;
        }
    }
    note(&format!("OCR sonucu: {got:?}"));
    let up = got.to_uppercase();
    check(
        up.contains(OCR_MARK_A) || up.contains(OCR_MARK_B),
        &format!("taranan metin karttaki damgayı içeriyor ({OCR_MARK_A} {OCR_MARK_B})"),
    );
    check(
        up.contains(OCR_MARK_A) && up.contains(OCR_MARK_B),
        "damganın HER İKİ kelimesi de tanındı",
    );
    sleep(400);
    delete_history_where(app, |c| c.to_uppercase().contains(OCR_MARK_A) || c == "qac-ocr-bekliyor");

    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(400);
    check(!visible(app, "capture-0"), "OCR sonrası overlay kapandı");
    remove_card(app);
}

/// 4. Kaydırmalı yakalama: GERÇEKTEN kayan bir liste üzerinde birleştirme.
fn flow_scroll(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— kaydırmalı yakalama —");
    let Some(card) = open_scroll_target(app, m) else {
        check(false, "kaydırma sınama penceresi açılamadı");
        return;
    };

    let before = gallery_ids(app);
    on_main(app, |h| crate::capture::start(h, "scroll"));
    if !check(wait_overlay(app, "capture-0"), "kaydırma overlay'i açıldı") {
        close_scroll_target(app);
        return;
    }

    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    eval(app, "capture-0", drag_js(qx, qy, qx + qw, qy + qh, 24));
    sleep(500);
    eval(app, "capture-0", press_js("btn-start"));

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use crate::capture::scroll_stream::ScrollState;
        let mut started = false;
        for _ in 0..40 {
            sleep(100);
            if app.state::<ScrollState>().0.lock().unwrap().is_some() {
                started = true;
                break;
            }
        }
        check(started, "Başlat: canlı akış kuruldu");
    }
    sleep(800);

    // Kaydırmayı RUST sürüyor: kartın kendi zamanlayıcısına güvenilmiyor, çünkü
    // overlay pencereyi örttüğünde WKWebView gizli sayılan belgenin
    // zamanlayıcılarını donduruyor (arayüz testinde bu üç kez sessizce öldürmüştü).
    for _ in 0..26 {
        eval(
            app,
            "qa-scroll-target",
            "(function(){const e=document.getElementById('qa-scroll'); if(e) e.scrollTop += 44;})();".to_string(),
        );
        sleep(220);
    }
    sleep(700);

    // Hareket GERÇEKTEN görüldü mü? Birleştiricinin kendi sayacı söylüyor: kaç
    // piksel satır işlendi, kaç kez birleşim yapıldı. Sıfırsa pencere kaymamış ya
    // da akış onu görmemiştir — ilk denemede tam olarak bu oldu (hedef CopyBoard'ın
    // kendi penceresiydi ve akıştan dışlanıyordu).
    clear_probes();
    eval(
        app,
        "capture-0",
        "window.api.sendDebugLog('QAC scroll.hud=' + (document.getElementById('hud-stats').textContent || 'bos'));".to_string(),
    );
    let hud = wait_probe("scroll.hud", 2500).unwrap_or_default();
    note(&format!("HUD sayacı: {hud}"));
    let nums: Vec<f64> = hud
        .split(|c: char| !c.is_ascii_digit())
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse().ok())
        .collect();
    let rows = nums.first().copied().unwrap_or(0.0);
    let commits = nums.get(1).copied().unwrap_or(0.0);
    check(
        rows > 0.0 && commits >= 5.0,
        &format!("kaydırma sırasında hareket izlendi ({rows:.0} px satır, {commits:.0} birleşim)"),
    );

    eval(app, "capture-0", press_js("btn-finish"));
    sleep(2500);

    const READ: &str = r#"(function(){
  window.api.sendDebugLog('QAC scroll.phase=' + document.body.className);
  window.api.sendDebugLog('QAC scroll.meta=' + (document.getElementById('preview-meta').textContent || ''));
})();"#;
    clear_probes();
    eval(app, "capture-0", READ.to_string());
    let phase = wait_probe("scroll.phase", 3000).unwrap_or_default();
    let meta = wait_probe("scroll.meta", 1500).unwrap_or_default();
    note(&format!("evre={phase} önizleme={meta}"));
    check(phase.contains("phase-review"), "Bitir: inceleme evresine geçildi");

    // Birleştirilen sayfa, tek bir kareden YÜKSEK olmalı — yoksa hiçbir satır
    // eklenmemiş, yalnız ilk kare gösteriliyordur.
    let dims: Vec<f64> = meta
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    let frame_h = qh * m.scale;
    let stitched_h = dims.get(1).copied().unwrap_or(0.0);
    check(
        stitched_h > frame_h * 1.2,
        &format!("birleştirilen görüntü tek kareden uzun ({stitched_h:.0} px > {frame_h:.0} px)"),
    );

    // İncelemeden Kopyala: ham tampon yolu (`snip_copy_buffer`).
    on_main(app, |_| crate::platform::clipboard_write_text("qac-scroll-bekliyor"));
    sleep(300);
    eval(app, "capture-0", press_js("btn-copy"));
    sleep(2500);
    match on_main(app, |_| clipboard_image()).flatten() {
        Some(img) => {
            note(&format!("panodaki birleşik görüntü: {}x{}", img.w, img.h));
            check(
                (img.h as f64 - stitched_h).abs() <= 4.0,
                "panoya yazılan görüntü önizlemedeki boyutta",
            );
        }
        None => {
            check(false, "Kopyala sonrası panoda birleşik görüntü yok");
        }
    }

    sleep(700);
    let after = gallery_ids(app);
    let new_ids: Vec<String> = after.iter().filter(|i| !before.contains(i)).cloned().collect();
    check(!new_ids.is_empty(), "birleşik görüntü galeriye eklendi");
    for id in &new_ids {
        let id = id.clone();
        on_main(app, move |h| crate::gallery::delete(h, &id));
    }

    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(600);
    check(!visible(app, "capture-0"), "kaydırma sonrası overlay kapandı");
    check(
        !app.state::<AppState>().runtime.lock().unwrap().is_capturing,
        "kaydırma sonrası oturum bayrağı düştü",
    );
    close_scroll_target(app);
}

// ── Temizlik ───────────────────────────────────────────────────────────────

fn gallery_ids(app: &tauri::AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    crate::gallery::public_list(&state.store)
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect()
}

/// Sınamanın panoya yazdıklarını kullanıcının geçmişinden siler. Bu harness
/// gerçek uygulamayı sürüyor, yani gerçek veri üretiyor — bıraksa kullanıcının
/// geçmişi çöple dolardı.
fn delete_history_where(app: &tauri::AppHandle, pred: impl Fn(&str) -> bool) {
    let ids: Vec<String> = {
        let state = app.state::<AppState>();
        crate::clipboard::history::history(&state.store)
            .iter()
            .filter(|i| i.get("content").and_then(|c| c.as_str()).map(&pred).unwrap_or(false))
            .filter_map(|i| i.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect()
    };
    for id in ids {
        on_main(app, move |h| crate::clipboard::history::delete(h, &id));
    }
}

// ── Giriş ──────────────────────────────────────────────────────────────────

/// `--qa-capture[=snip,color,ocr,scroll]`
pub fn run(app: tauri::AppHandle, which: String) {
    std::thread::Builder::new()
        .name("copyboard-qa-capture".into())
        .spawn(move || {
            sleep(2500); // açılış otursun
            let wanted: Vec<String> = if which.trim().is_empty() {
                vec!["snip".into(), "tools".into(), "color".into(), "ocr".into(), "scroll".into(), "multi".into()]
            } else {
                which.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()
            };
            note(&format!("başlıyor — akışlar: {}", wanted.join(", ")));

            let Some(m) = crate::geom::all_monitors(&app).into_iter().next() else {
                check(false, "monitör bulunamadı");
                return;
            };
            note(&format!(
                "monitör 0: ({:.0},{:.0}) {:.0}x{:.0} ×{:.2} {}",
                m.x, m.y, m.width, m.height, m.scale, m.name.as_deref().unwrap_or("?")
            ));

            let has = |k: &str| wanted.iter().any(|w| w == k);
            if has("snip") { flow_snip(&app, &m, 0); }
            if has("tools") { flow_tools(&app, &m); }
            if has("color") { flow_color(&app, &m); }
            if has("ocr") { flow_ocr(&app, &m); }
            if has("scroll") { flow_scroll(&app, &m); }
            // İkinci monitör: overlay'in DOĞRU ekrana, doğru ölçekle oturduğu ancak
            // orada seçim yapılıp piksel okunarak kanıtlanabiliyor (bkz. A11).
            if has("multi") {
                match crate::geom::all_monitors(&app).get(1) {
                    Some(m2) => {
                        note(&format!(
                            "monitör 1: ({:.0},{:.0}) {:.0}x{:.0} ×{:.2} {}",
                            m2.x, m2.y, m2.width, m2.height, m2.scale,
                            m2.name.as_deref().unwrap_or("?")
                        ));
                        flow_snip(&app, m2, 1);
                    }
                    None => note("ikinci monitör yok — çok monitör adımı atlandı"),
                }
            }

            // Panoyu sınamanın son çıktısıyla bırakma.
            on_main(&app, |_| crate::platform::clipboard_write_text(""));
            delete_history_where(&app, |c| c.starts_with("qac-"));

            let fails = *FAILS.lock().unwrap();
            note(&format!("bitti: {fails} başarısız adım"));
            println!("QAC SONUC: {fails} başarısız");
        })
        .ok();
}
