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
    // Sol ve sağ kenarda KOYU şerit: kırpmanın en dış sütunları buraya düşüyor.
    // Overlay'in beyaz seçim çerçevesi akışa sızarsa o sütunlar beyaz çıkar —
    // sızıntının tek gözle görülür izi bu, çünkü karartma seçimin İÇİNDE zaten
    // temizleniyor (`drawOverlay`: destination-out).
    list.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;background:#ffffff;border-left:14px solid #0d0d0d;border-right:14px solid #0d0d0d;box-sizing:border-box';
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
  // Tıklama geçirgenliği sınaması: overlay geçirgense gerçek tıklama BURAYA düşer.
  d.dataset.clicks = '0';
  d.addEventListener('mousedown', (e) => {
    d.dataset.clicks = String(Number(d.dataset.clicks || 0) + 1);
  });
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

/// Kaydedici ve kaydırma düğmeleri ise `click` dinliyor. Hangi düğmenin hangi
/// olayı dinlediği koda bakılarak belirlenmeli: yanlışını göndermek testi sessizce
/// yeşil yapar (`btn-record`a `mousedown` göndermek kaydı hiç başlatmıyordu).
fn click_el_js(id: &str) -> String {
    format!("document.getElementById('{id}')?.click();")
}

/// Snipper araç çubuğu düğmeleri `click` DEĞİL `mousedown` dinliyor — `.click()` çağırmak
/// hiçbir şey yapmazdı ve test sahte bir yeşil verirdi.
fn press_js(id: &str) -> String {
    format!(
        "document.getElementById('{id}')?.dispatchEvent(new MouseEvent('mousedown',{{bubbles:true,cancelable:true,button:0}}));"
    )
}

// ── Gerçek imleç (CGEvent) ────────────────────────────────────────────────
//
// Sentetik `MouseEvent` uygulamanın kendi dinleyicilerinden geçiyor ama işletim
// sisteminin isabet sınamasından geçmiyor: overlay yanlış monitörde dursa, yanlış
// katmanda olsa ya da tıklama geçirgen olsa sentetik olay bunu GÖRMEZ. Buradaki
// olaylar pencere sunucusuna gidiyor, yani imleç gerçekten hareket ediyor ve
// tıklama gerçekten isabet sınamasından geçiyor.
//
// Bedeli: Erişilebilirlik izni. Bu yüzden bu akışlar varsayılan listede DEĞİL.
#[cfg(target_os = "macos")]
mod mouse {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    type Ref = *mut c_void;

    const HID_TAP: u32 = 0;
    const SOURCE_HID: u32 = 1;
    const LEFT_DOWN: u32 = 1;
    const LEFT_UP: u32 = 2;
    const MOUSE_MOVED: u32 = 5;
    const LEFT_DRAGGED: u32 = 6;
    const BUTTON_LEFT: u32 = 0;
    /// kVK_Return — kaydetme panelinde varsayılan düğme (Kaydet).
    pub const KEY_RETURN: u16 = 0x24;
    /// FİZİKSEL tuş kodları (klavye düzeninden bağımsız).
    pub const KEY_V: u16 = 0x09;
    pub const KEY_9: u16 = 0x19;
    pub const KEY_2: u16 = 0x13;
    pub const KEY_4: u16 = 0x15;
    pub const KEY_8: u16 = 0x1C;
    pub const KEY_ESC: u16 = 0x35;
    /// kCGEventFlagMaskShift / …Alternate.
    pub const FLAG_SHIFT: u64 = 0x0002_0000;
    pub const FLAG_ALT: u64 = 0x0008_0000;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSetFlags(event: Ref, flags: u64);
        fn CGEventSourceCreate(state: u32) -> Ref;
        fn CGEventCreateMouseEvent(source: Ref, kind: u32, pos: CGPoint, button: u32) -> Ref;
        fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
        fn CGEventPost(tap: u32, event: Ref);
        fn CFRelease(cf: Ref);
    }

    fn post(kind: u32, x: f64, y: f64) {
        unsafe {
            let src = CGEventSourceCreate(SOURCE_HID);
            let ev = CGEventCreateMouseEvent(src, kind, CGPoint { x, y }, BUTTON_LEFT);
            if !ev.is_null() {
                CGEventPost(HID_TAP, ev);
                CFRelease(ev);
            }
            if !src.is_null() {
                CFRelease(src);
            }
        }
    }

    fn nap(ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }

    pub fn move_to(x: f64, y: f64) {
        post(MOUSE_MOVED, x, y);
        nap(60);
    }

    pub fn click(x: f64, y: f64) {
        move_to(x, y);
        post(LEFT_DOWN, x, y);
        nap(90);
        post(LEFT_UP, x, y);
        nap(150);
    }

    /// Basılı tut, ara noktalardan geç, bırak. Ara `mousemove`ler şart: seçim
    /// dikdörtgeni `mousemove` ile büyüyor, tek atlamada sıfır kalırdı.
    pub fn drag(x1: f64, y1: f64, x2: f64, y2: f64, steps: u32) {
        move_to(x1, y1);
        post(LEFT_DOWN, x1, y1);
        nap(120);
        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            post(LEFT_DRAGGED, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
            nap(25);
        }
        nap(120);
        post(LEFT_UP, x2, y2);
        nap(200);
    }

    /// Değiştiricili tuş vuruşu — global kısayolları sınamak için.
    ///
    /// Bayraklar HER İKİ olaya da konuyor: yalnız basmaya konsaydı Carbon'un
    /// `RegisterEventHotKey`i eşleşmeyi kaçırabilirdi.
    pub fn key_with_flags(code: u16, flags: u64) {
        unsafe {
            let src = CGEventSourceCreate(SOURCE_HID);
            for down in [true, false] {
                let ev = CGEventCreateKeyboardEvent(src, code, down);
                if !ev.is_null() {
                    CGEventSetFlags(ev, flags);
                    CGEventPost(HID_TAP, ev);
                    CFRelease(ev);
                }
                nap(80);
            }
            if !src.is_null() {
                CFRelease(src);
            }
        }
        nap(200);
    }

    pub fn key(code: u16) {
        unsafe {
            let src = CGEventSourceCreate(SOURCE_HID);
            for down in [true, false] {
                let ev = CGEventCreateKeyboardEvent(src, code, down);
                if !ev.is_null() {
                    CGEventPost(HID_TAP, ev);
                    CFRelease(ev);
                }
                nap(60);
            }
            if !src.is_null() {
                CFRelease(src);
            }
        }
    }
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

/// Panoyu bilinen bir METNE çeker — yani içindeki GÖRÜNTÜYÜ siler.
///
/// Kopyalama sınamalarından ÖNCE çağrılmalı. Aksi hâlde kopyalama başarısız olsa
/// bile bir önceki akışın görüntüsü panoda duruyor ve sınama onu YENİ sanıyor: tam
/// turda açıklama araçları tam olarak böyle "0 beyaz piksel" raporladı, oysa
/// okuduğu şey bir önceki akışın renkli çeyrek görüntüsüydü.
fn arm_clipboard(app: &tauri::AppHandle) {
    on_main(app, |_| crate::platform::clipboard_write_text("qac-bekliyor"));
    sleep(300);
}

/// Panoya bir GÖRÜNTÜ düşmesini bekler. Sabit `sleep` yerine yoklama: kopyalama
/// bazen 2 sn'den uzun sürüyor ve sabit bekleme yarışı kaybediyordu.
fn wait_clipboard_image(app: &tauri::AppHandle, ms: u64) -> Option<Img> {
    let until = Instant::now() + Duration::from_millis(ms);
    loop {
        if let Some(img) = on_main(app, |_| clipboard_image()).flatten() {
            return Some(img);
        }
        if Instant::now() >= until {
            return None;
        }
        sleep(250);
    }
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

/// Verilen dikdörtgende BEYAZ sayılabilecek piksel. Kalem rengi beyaza
/// çekildiğinde kartın dört çeyreğinin hiçbiri beyaza yakın değil.
fn count_white(img: &Img, x0: usize, y0: usize, x1: usize, y1: usize) -> usize {
    let mut n = 0;
    for y in y0..y1.min(img.h) {
        for x in x0..x1.min(img.w) {
            let i = (y * img.w + x) * 4;
            if i + 2 < img.rgba.len()
                && img.rgba[i] > 225
                && img.rgba[i + 1] > 225
                && img.rgba[i + 2] > 225
            {
                n += 1;
            }
        }
    }
    n
}

/// Göreli koordinattaki tek pikselin beyaz olup olmadığı — biçim ayırt etmek için
/// (dikdörtgenin köşesi doludur, elipsinki değil).
fn white_at(img: &Img, rx: f64, ry: f64) -> bool {
    let bw = ((img.w as f64) * 0.012).max(3.0) as usize;
    let cx = ((img.w as f64) * rx) as usize;
    let cy = ((img.h as f64) * ry) as usize;
    let x0 = cx.saturating_sub(bw);
    let y0 = cy.saturating_sub(bw);
    count_white(img, x0, y0, cx + bw, cy + bw) > 0
}

/// Verilen noktadaki küçük blokta kaç FARKLI renk var.
///
/// `blur` aracı aslında bir MOZAİK: bölgeyi 20×20 bloklara indirip her bloğu tek
/// renge çeviriyor. Düz renkli bir alanda hiçbir iz bırakmaz, o yüzden ölçüm dokulu
/// bir hedefin üstünde yapılıyor: mozaiklenen blokta tek renk kalır, dokunulmamış
/// blokta (beyaz darbe + arka plan + kenar yumuşatma) çok sayıda renk vardır.
fn distinct_colors(img: &Img, rx: f64, ry: f64, size: usize) -> usize {
    let cx = (img.w as f64 * rx) as usize;
    let cy = (img.h as f64 * ry) as usize;
    let mut seen = std::collections::HashSet::new();
    for y in cy..(cy + size).min(img.h) {
        for x in cx..(cx + size).min(img.w) {
            let i = (y * img.w + x) * 4;
            if i + 2 < img.rgba.len() {
                // 3 bit atılıyor: JPEG/renk uzayı gürültüsü ayrı renk sayılmasın.
                seen.insert((img.rgba[i] >> 3, img.rgba[i + 1] >> 3, img.rgba[i + 2] >> 3));
            }
        }
    }
    seen.len()
}

/// Bir sütunun ortalama parlaklığı.
fn column_mean(img: &Img, x: usize) -> f64 {
    let mut sum = 0f64;
    let mut n = 0f64;
    for y in 0..img.h {
        let i = (y * img.w + x) * 4;
        if i + 2 < img.rgba.len() {
            sum += (img.rgba[i] as f64 + img.rgba[i + 1] as f64 + img.rgba[i + 2] as f64) / 3.0;
            n += 1.0;
        }
    }
    if n == 0.0 { 0.0 } else { sum / n }
}

fn hex_of(c: (f64, f64, f64)) -> String {
    format!("#{:02x}{:02x}{:02x}", c.0 as u8, c.1 as u8, c.2 as u8)
}

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
    arm_clipboard(app);
    eval(app, &label, press_js("btn-copy"));

    let Some(img) = wait_clipboard_image(app, 8000) else {
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

/// Yakalamayı açar ve çeyrek bloğunu seçer.
fn snip_session(app: &tauri::AppHandle, card: &Card) -> bool {
    on_main(app, |h| crate::capture::start(h, "draw"));
    if !wait_overlay(app, "capture-0") {
        return false;
    }
    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    eval(app, "capture-0", drag_js(qx, qy, qx + qw, qy + qh, 20));
    sleep(400);
    true
}

/// Bir aracı seçer ve GERÇEKTEN seçildiğini uygulamadan geri okur.
fn pick_tool(app: &tauri::AppHandle, tool: &str) -> bool {
    clear_probes();
    eval(
        app,
        "capture-0",
        format!(
            "(function(){{document.querySelector('.tool-btn[data-tool=\"{tool}\"]').click();\
             window.api.sendDebugLog('QAC tool.active=' + (state.activeTool || 'yok'));}})();"
        ),
    );
    wait_probe("tool.active", 2500).as_deref() == Some(tool)
}

/// Açıklama araçları: altı aracın hepsi, biçimleriyle birlikte.
///
/// Yalnız "beyaz piksel var mı" diye bakmak yetmezdi: araç düğmesi hiç işlemese ve
/// kalem seçili kalsa da her çeyrekte iz olurdu. O yüzden BİÇİM ayırt ediliyor —
/// kalem köşegen bırakıyor (merkez dolu, kenar ortası boş), kare çerçeve (kenar
/// ortası VE köşe dolu), yuvarlak elips (kenar ortası dolu, köşe boş).
fn flow_tools(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— açıklama araçları —");
    let Some(card) = install_card(app, m, "colors") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };
    let before = gallery_ids(app);
    let (qx, qy, qw, qh) = card.quads_rect(6.0);

    // ── Oturum A: renk + kalem / kare / yuvarlak / ok ──────────────────────
    if !check(snip_session(app, &card), "seçim overlay'i açıldı (şekil araçları)") {
        remove_card(app);
        return;
    }

    // Kalem rengi BEYAZ: kartın dört çeyreğinin hiçbiri beyaza yakın değil, yani
    // hangi izin çizimden geldiği tartışmasız.
    clear_probes();
    eval(
        app,
        "capture-0",
        "(function(){document.querySelector('.color-dot[data-color=\"#ffffff\"]').click();\
          window.api.sendDebugLog('QAC pen.color=' + state.selectedColor);})();"
            .to_string(),
    );
    let color = wait_probe("pen.color", 2500).unwrap_or_default();
    check(color == "#ffffff", &format!("renk paleti uygulandı (okunan: {color})"));

    for (tool, fx, fy) in [("pen", 0.25, 0.25), ("rect", 0.75, 0.25), ("circle", 0.25, 0.75), ("arrow", 0.75, 0.75)] {
        check(pick_tool(app, tool), &format!("{tool}: araç etkinleşti"));
        let (cx, cy) = (qx + qw * fx, qy + qh * fy);
        let (dx, dy) = (qw * 0.15, qh * 0.15);
        eval(app, "capture-0", drag_js(cx - dx, cy - dy, cx + dx, cy + dy, 16));
        sleep(350);
    }

    arm_clipboard(app);
    eval(app, "capture-0", press_js("btn-copy"));
    match wait_clipboard_image(app, 8000) {
        Some(img) => {
            let (hw, hh) = (img.w / 2, img.h / 2);
            let counts = [
                ("kalem", count_white(&img, 0, 0, hw, hh)),
                ("kare", count_white(&img, hw, 0, img.w, hh)),
                ("yuvarlak", count_white(&img, 0, hh, hw, img.h)),
                ("ok", count_white(&img, hw, hh, img.w, img.h)),
            ];
            note(&format!("beyaz piksel: {counts:?}"));
            for (name, n) in counts {
                check(n > 400, &format!("{name}: iz kopyalanan görüntüde ({n} piksel)"));
            }
            check(
                white_at(&img, 0.25, 0.25) && !white_at(&img, 0.25, 0.10),
                "kalem KÖŞEGEN çizdi (merkez dolu, üst kenar ortası boş)",
            );
            check(
                white_at(&img, 0.75, 0.10) && white_at(&img, 0.60, 0.10) && !white_at(&img, 0.75, 0.25),
                "kare ÇERÇEVE çizdi (kenar ortası ve köşe dolu, merkez boş)",
            );
            check(
                white_at(&img, 0.25, 0.60) && !white_at(&img, 0.10, 0.60) && !white_at(&img, 0.25, 0.75),
                "yuvarlak ELİPS çizdi (kenar ortası dolu, köşe ve merkez boş)",
            );
            // Ok bir çizgi ARTI uç başlığı: bitiş çevresinde başlangıçtan belirgin
            // fazla piksel olmalı. Yoksa çizilen şey düz bir çizgidir.
            let bw = (img.w as f64 * 0.05) as usize;
            let bh = (img.h as f64 * 0.05) as usize;
            let at = |rx: f64, ry: f64| {
                let cx = (img.w as f64 * rx) as usize;
                let cy = (img.h as f64 * ry) as usize;
                count_white(&img, cx.saturating_sub(bw), cy.saturating_sub(bh), cx + bw, cy + bh)
            };
            let (head, tail) = (at(0.885, 0.885), at(0.615, 0.615));
            note(&format!("ok: uç çevresi={head} px, başlangıç çevresi={tail} px"));
            check(head > tail + 100, "ok UÇ BAŞLIĞI çizdi (bitişte belirgin fazlalık)");
        }
        None => {
            check(false, "şekil araçlarından sonra panoda resim yok");
        }
    }
    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(600);

    // ── Oturum B: bulanıklaştırma + metin ─────────────────────────────────
    // Ayrı oturum: bulanıklaştırma yukarıdaki beyaz izleri de bulaştırıp ölçümü
    // kirletirdi.
    if !check(snip_session(app, &card), "seçim overlay'i açıldı (bulanıklaştırma + metin)") {
        remove_card(app);
        return;
    }

    // Mozaik ancak DOKULU bir hedefte ölçülebiliyor: önce beyaz bir kalem darbesi
    // çiziliyor, sonra darbenin SOL yarısı mozaikleniyor. Sağ yarısı kontrol.
    clear_probes();
    eval(
        app,
        "capture-0",
        "(function(){document.querySelector('.color-dot[data-color=\"#ffffff\"]').click();\
          window.api.sendDebugLog('QAC pen.color=' + state.selectedColor);})();"
            .to_string(),
    );
    let _ = wait_probe("pen.color", 2500);
    check(pick_tool(app, "pen"), "kalem aracı etkinleşti (mozaik hedefi)");
    eval(
        app,
        "capture-0",
        drag_js(qx + qw * 0.10, qy + qh * 0.10, qx + qw * 0.90, qy + qh * 0.30, 40),
    );
    sleep(400);

    check(pick_tool(app, "blur"), "bulanıklaştırma aracı etkinleşti");
    eval(
        app,
        "capture-0",
        drag_js(qx + qw * 0.15, qy + qh * 0.06, qx + qw * 0.45, qy + qh * 0.34, 16),
    );
    sleep(500);

    // Metin: kutu tıklamayla açılıyor, değer yazılıp Enter ile işleniyor. Renk hâlâ
    // beyaz, yani yazı mavi çeyrekte tartışmasız ayırt ediliyor.
    check(pick_tool(app, "text"), "metin aracı etkinleşti");
    eval(app, "capture-0", click_js(qx + qw * 0.15, qy + qh * 0.68));
    sleep(600);
    clear_probes();
    eval(
        app,
        "capture-0",
        "(function(){const t=document.getElementById('text-input');\
          t.value='HHHHHHHH';\
          t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));\
          window.api.sendDebugLog('QAC text.done=' + (t.value === '' ? 'islendi' : 'duruyor'));})();"
            .to_string(),
    );
    let done = wait_probe("text.done", 2500).unwrap_or_default();
    check(done == "islendi", &format!("metin kutusu Enter ile işlendi (okunan: {done})"));

    arm_clipboard(app);
    eval(app, "capture-0", press_js("btn-copy"));
    match wait_clipboard_image(app, 8000) {
        Some(img) => {
            // Darbenin mozaiklenen yarısı ile dokunulmayan yarısı, aynı boyutta
            // birer blokta karşılaştırılıyor. Darbe x=0.30'da y≈0.15, x=0.70'te
            // y≈0.25 (eğim 0.20/0.80).
            let blok = 16;
            let mosaic = distinct_colors(&img, 0.30, 0.145, blok);
            let intact = distinct_colors(&img, 0.70, 0.245, blok);
            note(&format!("blokta farklı renk: mozaiklenen={mosaic}, dokunulmayan={intact}"));
            check(
                intact >= 6,
                &format!("kontrol bloğu dokulu (kalem darbesi orada, {intact} renk)"),
            );
            check(
                mosaic <= 4 && intact > mosaic * 2,
                &format!("mozaik bölgedeki detay silindi ({mosaic} renk, kontrol {intact})"),
            );

            let text_px = count_white(
                &img,
                (img.w as f64 * 0.08) as usize,
                (img.h as f64 * 0.60) as usize,
                (img.w as f64 * 0.55) as usize,
                (img.h as f64 * 0.82) as usize,
            );
            note(&format!("metin pikseli: {text_px}"));
            check(text_px > 150, "metin görüntüye YAZILDI");
        }
        None => {
            check(false, "bulanıklaştırma/metin sonrası panoda resim yok");
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
    // Hedef artık CopyBoard'un KENDİ ana penceresi. Eskiden mümkün değildi:
    // `scroll_begin` başlığında "CopyBoard" geçen her pencereyi akıştan siliyordu
    // ve uygulamanın her penceresinin başlığı buydu. Bu koşunun 0 satır vermesi
    // düzeltmenin geri alındığı anlamına gelir.
    let Some(card) = install_card(app, m, "scroll") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };

    let before = gallery_ids(app);
    on_main(app, |h| crate::capture::start(h, "scroll"));
    if !check(wait_overlay(app, "capture-0"), "kaydırma overlay'i açıldı") {
        remove_card(app);
        return;
    }

    // Kartı overlay'in ALTINA indir. Üstte kalsaydı overlay'in karartması ve
    // beyaz seçim çerçevesi kartın ARKASINDA kalırdı ve sızıntı ölçümü hiçbir şey
    // kanıtlamazdı — ölçtüğü şey katman sırası olurdu.
    lower_main(app);

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
            crate::windows::main_window::LABEL,
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
    match wait_clipboard_image(app, 10000) {
        Some(img) => {
            note(&format!("panodaki birleşik görüntü: {}x{}", img.w, img.h));
            check(
                (img.h as f64 - stitched_h).abs() <= 4.0,
                "panoya yazılan görüntü önizlemedeki boyutta",
            );
            // Sızıntı ölçümü: kırpmanın en dış sütunları kartın KOYU şeridine
            // düşüyor. Overlay'in 2 px beyaz seçim çerçevesi akışa girseydi burası
            // beyaz olurdu.
            let left = column_mean(&img, 0);
            let right = column_mean(&img, img.w.saturating_sub(1));
            note(&format!("kenar sütunları: sol={left:.0} sağ={right:.0} (koyu şerit ≈13)"));
            check(
                left < 90.0 && right < 90.0,
                "overlay'in seçim çerçevesi birleştirilen görüntüye SIZMADI",
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
    remove_card(app);
}

/// Ana pencereyi overlay'in ALTINA indirir.
///
/// Ana pencere `ScreenSaver` (1000), yakalama overlay'i `PopUpMenu` (101)
/// katmanında. Yani kart overlay'in ÜSTÜNDE duruyor ve gerçek bir tıklama
/// overlay'e hiç ulaşmazdı. Ekran görüntüsü zaten alındığı için kartın üstte
/// kalmasına gerek yok.
#[cfg(target_os = "macos")]
fn lower_main(app: &tauri::AppHandle) {
    on_main(app, |h| {
        if let Some(w) = h.get_webview_window(crate::windows::main_window::LABEL) {
            let _ = w.set_always_on_top(false);
        }
    });
    sleep(300);
}

/// Overlay'deki bir CSS noktasının EKRAN (global mantıksal) karşılığı.
fn to_screen(m: &MonitorInfo, cx: f64, cy: f64) -> (f64, f64) {
    (m.x + cx, m.y + cy)
}

/// Bir DOM ögesinin overlay içindeki merkezini okur.
#[cfg(target_os = "macos")]
fn element_center(app: &tauri::AppHandle, id: &str) -> Option<(f64, f64)> {
    clear_probes();
    eval(
        app,
        "capture-0",
        format!(
            "(function(){{const r=document.getElementById('{id}').getBoundingClientRect();\
             window.api.sendDebugLog('QAC el.center=' + (r.left+r.width/2) + ',' + (r.top+r.height/2));}})();"
        ),
    );
    let v = wait_probe("el.center", 2500)?;
    let mut it = v.split(',');
    let x: f64 = it.next()?.parse().ok()?;
    let y: f64 = it.next()?.parse().ok()?;
    // Gizli bir öge `0,0` döndürüyor. Buna tıklamak ekranın SOL ÜST köşesine —
    // yani menü çubuğuna — gerçek bir tıklama göndermek demek. Reddet.
    if x < 1.0 || y < 1.0 {
        log::error!("QAC {id}: öge görünmüyor (rect {x},{y}) — tıklama gönderilmedi");
        return None;
    }
    Some((x, y))
}

/// Sürükleme sonrası seçimin gerçekten oluştuğunu okur: dikdörtgen ve araç
/// çubuğunun görünürlüğü. Araç çubuğu gizliyse düğme konumu `0,0` çıkar.
#[cfg(target_os = "macos")]
fn read_selection(app: &tauri::AppHandle) -> (String, String) {
    clear_probes();
    const READ: &str = r#"(function(){
  const r = state.selectionRect || {x:-1,y:-1,w:-1,h:-1};
  window.api.sendDebugLog('QAC sel.rect=' + [r.x,r.y,r.w,r.h].map(v=>Math.round(v)).join(','));
  window.api.sendDebugLog('QAC sel.toolbar=' + getComputedStyle(document.getElementById('toolbar')).display);
})();"#;
    eval(app, "capture-0", READ.to_string());
    (
        wait_probe("sel.rect", 3000).unwrap_or_default(),
        wait_probe("sel.toolbar", 1500).unwrap_or_default(),
    )
}

/// GERÇEK imleçle bölge seçimi: işletim sisteminin isabet sınamasından geçen tek sınama.
#[cfg(target_os = "macos")]
fn flow_pointer(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— GERÇEK imleç: bölge seçimi —");
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
    lower_main(app);

    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    let (x1, y1) = to_screen(m, qx, qy);
    let (x2, y2) = to_screen(m, qx + qw, qy + qh);
    clear_probes();
    mouse::drag(x1, y1, x2, y2, 22);
    sleep(500);

    let (rect, toolbar) = read_selection(app);
    check(toolbar == "flex", &format!("araç çubuğu belirdi (display={toolbar})"));
    let got: Vec<f64> = rect.split(',').filter_map(|v| v.parse().ok()).collect();
    let want = [qx, qy, qw, qh];
    note(&format!("gerçek imleçle seçim={rect} (istenen {want:?})"));
    check(
        got.len() == 4 && got.iter().zip(want.iter()).all(|(a, b)| (a - b).abs() <= 3.0),
        "GERÇEK fare sürüklemesi overlay'e doğru ekran koordinatında ulaştı",
    );

    // Kopyala düğmesine GERÇEK tıklama.
    let Some((bx, by)) = element_center(app, "btn-copy") else {
        check(false, "Kopyala düğmesinin konumu okunamadı");
        remove_card(app);
        return;
    };
    let (sx, sy) = to_screen(m, bx, by);
    arm_clipboard(app);
    mouse::click(sx, sy);

    match wait_clipboard_image(app, 8000) {
        Some(img) => {
            let tl = sample(&img, 0.25, 0.25);
            let br = sample(&img, 0.75, 0.75);
            note(&format!("çeyrekler: SolÜst={} SağAlt={}", hex_of(tl), hex_of(br)));
            check(tl.0 > tl.1 + 40.0 && tl.0 > tl.2 + 40.0, "gerçek tıklamayla kopyalanan görüntü doğru bölge");
            check(br.0 > br.2 + 60.0 && br.1 > br.2 + 60.0, "kopyalanan görüntünün sağ altı SARI");
        }
        None => {
            check(false, "gerçek tıklamadan sonra panoda resim yok");
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

/// Bir DOM düğmesine GERÇEK tıklama.
///
/// İmleç önce götürülüp bekleniyor: overlay'in tıklanabilirliği isabet ALANIYLA
/// yönetiliyor ve ana süreç imleci 30 ms'de bir yokluyor. Hemen tıklamak, pencere
/// henüz geçirgenken tıklamak olurdu.
#[cfg(target_os = "macos")]
fn real_click_element(app: &tauri::AppHandle, m: &MonitorInfo, id: &str) -> bool {
    let Some((bx, by)) = element_center(app, id) else {
        return false;
    };
    let (sx, sy) = to_screen(m, bx, by);
    mouse::move_to(sx, sy);
    sleep(500);
    mouse::click(sx, sy);
    true
}

/// BAŞKA bir uygulamayı öne getirir — CopyBoard artık aktif uygulama değil.
///
/// Kullanıcının gerçek durumu bu: başka bir uygulamada çalışırken kısayola basıyor.
/// Harness'ın önceki akışları sınama kartını göstermek için `main_window::show`
/// çağırıyor ve o `activate_app()` yaptığı için CopyBoard ZATEN aktif oluyordu —
/// bu yüzden aşağıdaki hata testlerden kaçmıştı.
#[cfg(target_os = "macos")]
fn activate_other_app() {
    use objc2_app_kit::NSRunningApplication;
    use objc2::rc::autoreleasepool;
    use objc2_foundation::NSString;
    // `NSRunningApplication` ana thread istemiyor — `paste.rs` de aynı yerden
    // çağırıyor.
    autoreleasepool(|_| {
        let ns_id = NSString::from_str("com.apple.finder");
        let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&ns_id);
        if let Some(other) = running.iter().next() {
            other.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions::empty());
        }
    });
    sleep(900);
}

/// Overlay açıldığında İLK sürükleme çalışıyor mu?
///
/// Kullanıcı bildirdi: "ekran görüntüsü, kaydırmalı görüntü, video ve OCR'da
/// doğrudan alan seçemiyorum, bir kere tıkladıktan sonra seçebiliyorum."
///
/// Sebep: CopyBoard Dock'u gizli bir yardımcı uygulama (`ActivationPolicy::Accessory`)
/// ve `snip_ready` overlay'i gösterirken `show()` + `set_focus()` çağırıyor ama
/// `activate_app()` ÇAĞIRMIYOR. Ana pencerede o çağrı var ve yorumunda sebebi
/// yazılı. Uygulama aktif olmadığı için AppKit ilk tıklamayı pencereyi
/// etkinleştirmeye harcıyor — kullanıcının tarif ettiği "önce bir tıkla" tam olarak
/// bu.
///
/// Bu akış CopyBoard'u BİLEREK arka plana atıyor; önceki akışlar sınama kartını
/// göstermek için `main_window::show` çağırdığından uygulama zaten aktif oluyordu
/// ve hata hepsinden kaçmıştı.
#[cfg(target_os = "macos")]
fn flow_firstclick(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— overlay'de İLK sürükleme (uygulama arka plandayken) —");

    // Yakalama GERÇEK KISAYOLLA açılıyor — kullanıcının yolu bu. Rust'tan
    // `capture::start` çağırmak yeterli değildi: o çağrı zaten uygulamanın
    // içinden geliyor ve hatayı gizliyordu.
    for (mode, key, label) in [
        ("draw", mouse::KEY_9, "ekran görüntüsü"),
        ("ocr", mouse::KEY_2, "OCR"),
        ("scroll", mouse::KEY_4, "kaydırmalı"),
        ("video", mouse::KEY_8, "video"),
    ] {
        let _ = mode;
        on_main(app, |h| crate::capture::close_all(h, None));
        sleep(800);
        activate_other_app();

        mouse::key_with_flags(key, mouse::FLAG_ALT | mouse::FLAG_SHIFT);
        if !check(wait_overlay(app, "capture-0"), &format!("{label}: overlay açıldı")) {
            continue;
        }

        // Ölçü, tıklamanın SAYFAYA ULAŞMASI. `state.selectionRect` okumak
        // güvenilmez: OCR sayfasında öyle bir nesne yok, kaydırma sayfası ise
        // modül olduğu için `eval`den erişilemiyor — ikisinde de sonda sessizce
        // boş dönüp sahte yeşil veriyordu. Olay sayacı dört sayfada da çalışıyor
        // ve bildirilen belirtinin ta kendisini ölçüyor.
        eval(
            app,
            "capture-0",
            "window.__qacDown = 0; window.__qacMove = 0;\
             document.addEventListener('mousedown', () => { window.__qacDown++; }, true);\
             document.addEventListener('mousemove', () => { window.__qacMove++; }, true);"
                .to_string(),
        );
        sleep(300);

        // ── ÖNCE yalnız HAREKET, tıklama YOK ──────────────────────────────
        // Kullanıcının ilk belirtisi buydu: "renk göstergesi fareyi takip
        // etmiyor". Gösterge `mousemove` ile güncelleniyor ve key OLMAYAN bir
        // pencere `mouseMoved` almıyor. Tıklama sayısını ölçmek bunu kaçırıyordu.
        for i in 0..12 {
            let t = i as f64 / 12.0;
            let (mx, my) = to_screen(m, m.width * (0.30 + 0.30 * t), m.height * (0.30 + 0.30 * t));
            mouse::move_to(mx, my);
        }
        sleep(400);
        clear_probes();
        eval(
            app,
            "capture-0",
            "window.api.sendDebugLog('QAC fc.move=' + (window.__qacMove ?? -1));".to_string(),
        );
        let moves: i32 = wait_probe("fc.move", 3000)
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(-1);
        note(&format!("{label}: tıklamadan ÖNCE fare hareketi = {moves}"));
        check(
            moves >= 1,
            &format!("{label}: fare hareketi sayfaya ulaşıyor (gösterge takip eder)"),
        );

        // TEK sürükleme — kullanıcının "bir kere tıkladıktan sonra" dediği ikinci
        // deneme YOK.
        let (x1, y1) = to_screen(m, m.width * 0.30, m.height * 0.30);
        let (x2, y2) = to_screen(m, m.width * 0.60, m.height * 0.60);
        mouse::drag(x1, y1, x2, y2, 22);
        sleep(600);

        clear_probes();
        eval(
            app,
            "capture-0",
            "(function(){const b=document.getElementById('selection-box');\
              const r=b?b.getBoundingClientRect():null;\
              window.api.sendDebugLog('QAC fc.down=' + (window.__qacDown ?? -1)\
                + ' kutu=' + (r ? Math.round(r.width)+'x'+Math.round(r.height) : 'yok'));})();"
                .to_string(),
        );
        // OCR'da `mouseup` taramayı BAŞLATIYOR ve `ocr_process` overlay'leri hemen
        // kapatıyor — sayaç okunacak sayfa kalmıyor. Orada işaret şu: overlay
        // kapandıysa tıklama ulaşmıştır, hâlâ açıksa ulaşmamıştır.
        if mode == "ocr" {
            let mut kapandi = false;
            for _ in 0..30 {
                sleep(200);
                if !visible(app, "capture-0") {
                    kapandi = true;
                    break;
                }
            }
            note(&format!("{label}: sürükleme sonrası overlay kapandı = {kapandi}"));
            check(
                kapandi,
                &format!("{label}: İLK sürükleme taramayı başlattı (önce tıklamak gerekmiyor)"),
            );
            continue;
        }

        let got = wait_probe("fc.down", 3000).unwrap_or_default();
        note(&format!("{label}: {got}"));
        // Sonda anahtarı ayırdığı için değer "<sayı> kutu=WxH" biçiminde geliyor.
        let downs: i32 = got.split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or(-1);
        check(
            downs >= 1,
            &format!("{label}: İLK tıklama sayfaya ULAŞTI (önce tıklamak gerekmiyor)"),
        );
    }

    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(500);
}

/// Global kısayollar: GERÇEK tuş vuruşuyla.
///
/// Kısayollar Carbon `RegisterEventHotKey` ile kaydediliyor
/// (`platform/macos/hotkey_carbon.rs`) ve açılışta günlüğe "7 kayıtlı" düşüyor —
/// ama kayıtlı olmak ÇALIŞTIĞI anlamına gelmiyor. Sentetik olayla da ölçülemez:
/// global kısayol işletim sisteminin olay hattında çözülüyor, uygulamanın DOM'unda
/// değil. Tek yol gerçek tuş vuruşu.
#[cfg(target_os = "macos")]
fn flow_hotkey(app: &tauri::AppHandle, _m: &MonitorInfo) {
    note("— global kısayollar (gerçek tuş vuruşu) —");

    // ── Alt+Shift+V: ana pencere ──────────────────────────────────────────
    on_main(app, crate::windows::main_window::hide);
    sleep(700);
    check(!visible(app, "main"), "başlangıç: ana pencere gizli");

    mouse::key_with_flags(mouse::KEY_V, mouse::FLAG_ALT | mouse::FLAG_SHIFT);
    let mut shown = false;
    for _ in 0..30 {
        sleep(100);
        if visible(app, "main") {
            shown = true;
            break;
        }
    }
    check(shown, "Alt+Shift+V ana pencereyi açtı");
    on_main(app, crate::windows::main_window::hide);
    sleep(500);

    // ── Alt+Shift+9: ekran görüntüsü ──────────────────────────────────────
    mouse::key_with_flags(mouse::KEY_9, mouse::FLAG_ALT | mouse::FLAG_SHIFT);
    let mut opened = false;
    for _ in 0..50 {
        sleep(100);
        if visible(app, "capture-0") {
            opened = true;
            break;
        }
    }
    check(opened, "Alt+Shift+9 yakalama overlay'ini açtı");
    check(
        app.state::<AppState>().runtime.lock().unwrap().is_capturing,
        "kısayol sonrası oturum bayrağı kalktı (is_capturing)",
    );

    // Esc ile kapat — overlay odakta olduğu için düz tuş yetiyor.
    sleep(400);
    mouse::key(mouse::KEY_ESC);
    let mut closed = false;
    for _ in 0..40 {
        sleep(100);
        if !visible(app, "capture-0") {
            closed = true;
            break;
        }
    }
    check(closed, "Esc yakalamayı kapattı");
    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(400);
    check(
        !app.state::<AppState>().runtime.lock().unwrap().is_capturing,
        "kapanış sonrası oturum bayrağı düştü",
    );

    // ── Olumsuz durum: kısayol KAPALIYKEN aynı tuş hiçbir şey yapmamalı ────
    //
    // Bu adım olmadan yukarıdaki yeşiller pek az şey söylerdi: overlay başka bir
    // sebeple de açılmış olabilirdi. Aynı zamanda kısayolu açıp kapatma özelliğini
    // de sınıyor — ayarlar panelindeki anahtar bu yolu kullanıyor.
    on_main(app, |h| crate::shortcuts::set_enabled(h, crate::state::ShortcutKey::Draw, false));
    sleep(700);
    mouse::key_with_flags(mouse::KEY_9, mouse::FLAG_ALT | mouse::FLAG_SHIFT);
    let mut acildi = false;
    for _ in 0..25 {
        sleep(100);
        if visible(app, "capture-0") {
            acildi = true;
            break;
        }
    }
    check(!acildi, "kısayol KAPALIYKEN Alt+Shift+9 hiçbir şey açmadı");

    // Kullanıcının ayarını geri koy.
    on_main(app, |h| crate::shortcuts::set_enabled(h, crate::state::ShortcutKey::Draw, true));
    sleep(700);
    mouse::key_with_flags(mouse::KEY_9, mouse::FLAG_ALT | mouse::FLAG_SHIFT);
    let mut geri = false;
    for _ in 0..40 {
        sleep(100);
        if visible(app, "capture-0") {
            geri = true;
            break;
        }
    }
    check(geri, "kısayol yeniden AÇILINCA tekrar çalıştı");
    mouse::key(mouse::KEY_ESC);
    sleep(600);
    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(400);
}

/// A7: kaydırmalı yakalamada "Bitir" sonrası Kopyala GERÇEKTEN tıklanabiliyor mu?
///
/// Bildirilen hata isabet alanıyla ilgiliydi: overlay yakalama sırasında yalnız
/// araç çubuğunun dikdörtgeninde tıklanabilir kalıyor ve o dikdörtgen evre
/// değişiminden ÖNCE bildiriliyordu — inceleme evresinde ESKİ araç çubuğunun yeri
/// tıklanıyor, yenisi ölü kalıyordu.
///
/// Sentetik olayla ölçülemez: sentetik `mousedown` işletim sisteminin isabet
/// sınamasından geçmiyor ve düğmeye her hâlükârda ulaşıyor. Bu akış Başlat, Bitir
/// ve Kopyala'nın ÜÇÜNE de gerçek imleçle basıyor.
#[cfg(target_os = "macos")]
fn flow_a7(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— A7: inceleme evresinde Kopyala gerçekten tıklanabiliyor mu —");
    let Some(card) = install_card(app, m, "scroll") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };
    let before = gallery_ids(app);

    on_main(app, |h| crate::capture::start(h, "scroll"));
    if !check(wait_overlay(app, "capture-0"), "kaydırma overlay'i açıldı") {
        remove_card(app);
        return;
    }
    lower_main(app);

    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    let (x1, y1) = to_screen(m, qx, qy);
    let (x2, y2) = to_screen(m, qx + qw, qy + qh);
    mouse::drag(x1, y1, x2, y2, 22);
    sleep(700);

    check(real_click_element(app, m, "btn-start"), "Başlat'a gerçek tıklama gönderildi");
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use crate::capture::scroll_stream::ScrollState;
        let mut started = false;
        for _ in 0..50 {
            sleep(100);
            if app.state::<ScrollState>().0.lock().unwrap().is_some() {
                started = true;
                break;
            }
        }
        check(started, "Başlat GERÇEK tıklamayla işledi (akış kuruldu)");
    }
    sleep(600);

    for _ in 0..24 {
        eval(
            app,
            crate::windows::main_window::LABEL,
            "(function(){const e=document.getElementById('qa-scroll'); if(e) e.scrollTop += 44;})();".to_string(),
        );
        sleep(220);
    }
    sleep(700);

    check(real_click_element(app, m, "btn-finish"), "Bitir'e gerçek tıklama gönderildi");
    sleep(3000);

    clear_probes();
    eval(
        app,
        "capture-0",
        "window.api.sendDebugLog('QAC a7.phase=' + document.body.className);".to_string(),
    );
    let phase = wait_probe("a7.phase", 3000).unwrap_or_default();
    note(&format!("evre: {phase}"));
    if !check(phase.contains("phase-review"), "Bitir GERÇEK tıklamayla işledi (inceleme evresi)") {
        on_main(app, |h| crate::capture::close_all(h, None));
        remove_card(app);
        return;
    }

    // ── A7'nin kendisi ────────────────────────────────────────────────────
    on_main(app, |_| crate::platform::clipboard_write_text("qac-a7-bekliyor"));
    sleep(400);
    check(real_click_element(app, m, "btn-copy"), "Kopyala'ya gerçek tıklama gönderildi");

    match wait_clipboard_image(app, 10000) {
        Some(img) => {
            note(&format!("panodaki görüntü: {}x{}", img.w, img.h));
            check(
                img.h as f64 > qh * m.scale * 1.2,
                "A7 KAPANDI: inceleme evresinde Kopyala gerçek tıklamayla çalıştı",
            );
        }
        None => {
            check(false, "A7: Kopyala'ya gerçek tıklamadan sonra panoda görüntü YOK");
        }
    }

    sleep(700);
    for id in gallery_ids(app).iter().filter(|i| !before.contains(i)) {
        let id = id.clone();
        on_main(app, move |h| crate::gallery::delete(h, &id));
    }
    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(600);
    delete_history_where(app, |c| c.starts_with("qac-"));
    remove_card(app);
}

/// Yerel kaydetme paneli: Kaydet'e GERÇEK tıklama, panelde Return, diske düşen
/// dosyanın PİKSELLERİ.
#[cfg(target_os = "macos")]
fn flow_savepanel(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— yerel kaydetme paneli —");
    let Some(dir) = on_main(app, |h| h.path().picture_dir().ok()).flatten() else {
        check(false, "Resimler klasörü bulunamadı");
        return;
    };
    let existing = snip_files(&dir);
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
    lower_main(app);

    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    let (x1, y1) = to_screen(m, qx, qy);
    let (x2, y2) = to_screen(m, qx + qw, qy + qh);
    mouse::drag(x1, y1, x2, y2, 22);
    sleep(700);
    let (mut rect, mut toolbar) = read_selection(app);
    if toolbar != "flex" {
        // Overlay yeni odaklanmış olabiliyor: ilk gerçek basış bazen pencereyi
        // etkinleştirmekle harcanıyor. Bir kez daha dene — kullanıcı da öyle yapar.
        note(&format!("ilk sürükleme seçim üretmedi (rect={rect}) — yeniden deneniyor"));
        mouse::click(x1, y1);
        sleep(300);
        mouse::drag(x1, y1, x2, y2, 22);
        sleep(700);
        (rect, toolbar) = read_selection(app);
    }
    note(&format!("seçim={rect} araçÇubuğu={toolbar}"));
    if !check(toolbar == "flex", "Kaydet öncesi seçim oluştu") {
        on_main(app, |h| crate::capture::close_all(h, None));
        remove_card(app);
        return;
    }

    let Some((bx, by)) = element_center(app, "btn-save") else {
        check(false, "Kaydet düğmesinin konumu okunamadı");
        remove_card(app);
        return;
    };
    let (sx, sy) = to_screen(m, bx, by);
    mouse::click(sx, sy);
    // Panelin belirmesi: `save_png` overlay'i indirip rfd'yi açıyor.
    sleep(2600);
    // Varsayılan düğme Kaydet.
    mouse::key(mouse::KEY_RETURN);

    let mut saved = None;
    for _ in 0..40 {
        sleep(250);
        if let Some(f) = snip_files(&dir).into_iter().find(|f| !existing.contains(f)) {
            saved = Some(f);
            break;
        }
    }
    match saved {
        Some(path) => {
            note(&format!("panelden kaydedilen dosya: {}", path.display()));
            check(true, "kaydetme paneli açıldı ve Return ile onaylandı");
            match std::fs::read(&path).ok().and_then(|b| image::load_from_memory(&b).ok()) {
                Some(im) => {
                    let rgba = im.to_rgba8();
                    let img = Img { w: rgba.width() as usize, h: rgba.height() as usize, rgba: rgba.into_raw() };
                    let want_w = (qw * m.scale).round() as usize;
                    check(
                        img.w.abs_diff(want_w) <= 2,
                        &format!("kaydedilen dosya seçimin boyutunda ({}x{}, beklenen genişlik {want_w})", img.w, img.h),
                    );
                    let tl = sample(&img, 0.25, 0.25);
                    let tr = sample(&img, 0.75, 0.25);
                    note(&format!("dosyadaki çeyrekler: SolÜst={} SağÜst={}", hex_of(tl), hex_of(tr)));
                    check(tl.0 > tl.1 + 40.0 && tl.0 > tl.2 + 40.0, "kaydedilen dosyanın sol üstü KIRMIZI");
                    check(tr.1 > tr.0 + 40.0 && tr.1 > tr.2 + 40.0, "kaydedilen dosyanın sağ üstü YEŞİL");
                }
                None => {
                    check(false, "kaydedilen dosya çözümlenemedi");
                }
            }
            // Sınamanın kullanıcının Resimler klasöründe bıraktığı dosyayı KALDIR.
            if let Err(e) = std::fs::remove_file(&path) {
                log::warn!("QAC sınama dosyası silinemedi: {e}");
            } else {
                note("sınama dosyası Resimler klasöründen silindi");
            }
        }
        None => {
            check(false, "kaydetme panelinden dosya çıkmadı");
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

/// Tıklama geçirgenliği: kayıt sürerken overlay'in ÜSTÜNDEN yapılan gerçek bir
/// tıklama ALTTAKİ pencereye ulaşmalı. Sentetik olayla ölçülemeyen tek şey buydu.
#[cfg(target_os = "macos")]
fn flow_clickthrough(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— tıklama geçirgenliği (kayıt sürerken) —");
    if !crate::capture::recorder::is_supported() {
        note("video kaydı bu macOS sürümünde yok — adım atlandı");
        return;
    }
    let Some(card) = install_card(app, m, "colors") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };
    let before_vids = video_ids(app);

    on_main(app, |h| crate::capture::start(h, "video"));
    if !check(wait_overlay(app, "capture-0"), "kaydedici overlay'i açıldı") {
        remove_card(app);
        return;
    }
    lower_main(app);
    sleep(600);

    // ── Olumsuz durum ÖNCE ────────────────────────────────────────────────
    // Kayıt başlamadan overlay TAMAMEN etkileşimli (`setHitAreas([{everything}])`).
    // Buradaki gerçek tıklama alttaki pencereye ULAŞMAMALI. Bu adım olmasa test
    // "hiç tıklama gitmiyor" ile "geçirgenlik çalışıyor"u ayırt edemezdi.
    let (cx, cy) = card.tl_center();
    let (sx, sy) = to_screen(m, cx, cy);
    mouse::move_to(sx, sy);
    sleep(700);
    mouse::click(sx, sy);
    sleep(500);

    // Kayıt bir SEÇİM olmadan başlamıyor (`startRecording`: `if (!state.selectionRect) return;`).
    // Gerçek sürüklemeyle seç — kullanıcının yaptığının aynısı.
    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    let (dx1, dy1) = to_screen(m, qx, qy);
    let (dx2, dy2) = to_screen(m, qx + qw, qy + qh);
    mouse::drag(dx1, dy1, dx2, dy2, 22);
    sleep(700);

    // Sayfa gerçekten hazır mı? Kayıt düğmesi bir seçim oluşmadan iş görmüyor.
    clear_probes();
    eval(
        app,
        "capture-0",
        r#"(function(){
  const b = document.getElementById('btn-record');
  let r = null; try { r = state.selectionRect; } catch (e) { }
  window.api.sendDebugLog('QAC rec.state=[' + document.body.className + ']'
    + ' btn=' + (b ? getComputedStyle(b).display : 'yok')
    + ' secim=' + (r ? Math.round(r.w) + 'x' + Math.round(r.h) : 'yok'));
})();"#
            .to_string(),
    );
    note(&format!("kaydedici durumu: {}", wait_probe("rec.state", 2500).unwrap_or_default()));

    eval(app, "capture-0", click_el_js("btn-record"));
    let mut rec = false;
    for _ in 0..50 {
        sleep(100);
        if app.state::<crate::capture::recorder::RecorderState>().0.lock().unwrap().is_some() {
            rec = true;
            break;
        }
    }
    check(rec, "kayıt başladı");
    sleep(1500);

    // ── Olumlu durum ──────────────────────────────────────────────────────
    // Kayıt sürerken overlay yalnız araç çubuğunun dikdörtgeninde tıklanabilir;
    // gerisi geçirgen. Geçirgenlik ANLIK DEĞİL: ana süreç imleci 30 ms'de bir
    // yokluyor ve konuma göre pencereyi geçirgen yapıyor (`windows/hit_test.rs`).
    //
    // Overlay'e de bir sayaç takılıyor: tıklama ORAYA düşerse geçirgenlik hiç
    // çalışmamış demektir. İki sayaç, üç durumu ayırt ediyor (overlay yedi /
    // kart aldı / ikisi de almadı) — tek sayaçla "çalışmıyor" ile "tıklama başka
    // yere gitti" ayırt edilemezdi.
    eval(
        app,
        "capture-0",
        "window.__qacHits = 0; document.addEventListener('mousedown', () => { window.__qacHits++; }, true);".to_string(),
    );
    sleep(200);

    // İKİ tıklama: macOS'ta etkin OLMAYAN bir pencereye ilk tıklama pencereyi
    // etkinleştirmekle harcanıyor ve içeriğe hiç ulaşmıyor (AppKit "first mouse").
    // Kullanıcı da farkında olmadan bunu yapıyor; ölçülen şey ikincisinin ulaşması.
    mouse::move_to(sx, sy);
    sleep(900);
    mouse::click(sx, sy);
    sleep(500);
    mouse::click(sx, sy);
    sleep(600);

    clear_probes();
    eval(
        app,
        "capture-0",
        "window.api.sendDebugLog('QAC ov.hits=' + (window.__qacHits ?? -1));".to_string(),
    );
    let overlay_hits = wait_probe("ov.hits", 2500).unwrap_or_default();
    note(&format!("overlay'in yediği tıklama: {overlay_hits} (0 olmalı — geçirgen)"));
    check(overlay_hits == "0", "kayıt sırasında overlay tıklamayı YEMEDİ");

    eval(app, "capture-0", click_el_js("btn-stop"));
    sleep(9000);
    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(800);

    // Sayaç ANCAK ŞİMDİ okunuyor: overlay pencereyi örterken WKWebView belgeyi
    // gizli sayıp zamanlayıcıları donduruyor ve günlük geç geliyor. Ölçülen şey
    // tıklamanın ULAŞIP ULAŞMADIĞI, ne zaman raporlandığı değil.
    on_main(app, crate::windows::main_window::show);
    sleep(700);
    clear_probes();
    eval(
        app,
        crate::windows::main_window::LABEL,
        "window.api.sendDebugLog('QAC card.clicks=' + (document.getElementById('qa-card')?.dataset.clicks ?? 'kart-yok'));".to_string(),
    );
    let clicks = wait_probe("card.clicks", 3000).unwrap_or_default();
    note(&format!("kartın saydığı tıklama: {clicks:?} (beklenen 1: kayıt öncesi geçmemeli, kayıt sırasında geçmeli)"));
    // Kayıt ÖNCESİ tek tıklama geçmemeli (overlay o an tamamen etkileşimli),
    // kayıt SIRASINDA iki tıklamadan en az biri geçmeli.
    let n: u32 = clicks.parse().unwrap_or(0);
    check(
        n >= 1,
        &format!("tıklama geçirgenliği: kayıt sırasında tıklama ALTTAKİ pencereye ulaştı ({n})"),
    );

    for id in video_ids(app).iter().filter(|i| !before_vids.contains(i)) {
        let id = id.clone();
        on_main(app, move |h| crate::videos::delete(h, &id, true));
    }
    on_main(app, |h| crate::capture::close_all(h, None));
    sleep(600);
    remove_card(app);
}

#[cfg(target_os = "macos")]
fn snip_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("snip_") && n.ends_with(".png"))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn video_ids(app: &tauri::AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    crate::videos::public_list(&state.store)
        .iter()
        .filter_map(|v| v.get("id").and_then(|i| i.as_str()).map(str::to_string))
        .collect()
}

/// Akıştan TEK kare alır. `exclude` boş verilirse ayıklama yapılmaz — iki koşuyu
/// karşılaştırmak, ayıklamanın gerçekten iş yapıp yapmadığını söyleyen tek ölçüm.
///
/// (İskeleti `claude/overlay-exclusion` dalındaki ölçümden alındı.)
#[cfg(target_os = "macos")]
fn grab_frame(m: &MonitorInfo, x: f64, y: f64, w: f64, h: f64, exclude: &[u32]) -> Option<Img> {
    use std::sync::Arc;
    // SON kare tutuluyor: ScreenCaptureKit'in ilk kareleri boş/bayat gelebiliyor.
    let slot: Arc<Mutex<Option<Img>>> = Arc::new(Mutex::new(None));
    let sink = slot.clone();
    let channel = tauri::ipc::Channel::<tauri::ipc::InvokeResponseBody>::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Raw(b) = body {
            // Başlık: `u32 seq | u32 w | u32 h`, ardından RGBA (scroll_stream::HEADER).
            if b.len() >= 12 {
                let fw = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
                let fh = u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize;
                if fw > 0 && fh > 0 && b.len() >= 12 + fw * fh * 4 {
                    *sink.lock().unwrap() =
                        Some(Img { w: fw, h: fh, rgba: b[12..12 + fw * fh * 4].to_vec() });
                }
            }
        }
        Ok(())
    });

    let sc = m.scale;
    let mut stream = match crate::capture::scroll_stream::start(
        m, x * sc, y * sc, w * sc, h * sc, 15, exclude, channel,
    ) {
        Ok(st) => st,
        Err(e) => {
            log::error!("QAC ölçüm akışı kurulamadı: {e}");
            return None;
        }
    };
    sleep(1400);
    stream.stop();
    sleep(200);
    let img = slot.lock().unwrap().take();
    img
}

/// Ayıklama listesi GERÇEKTEN iş yapıyor mu, yoksa `content_protected` tek başına
/// mı yetiyor?
///
/// Overlay seçim yokken TÜM ekranı %50 siyahla karartıyor ve altında yakalama anının
/// DONMUŞ görüntüsünü tutuyor. Overlay akışa girerse kart kararmış görünür. Aynı
/// bölge iki kez okunuyor: bir kez overlay'in kimlikleri dışlanarak, bir kez BOŞ
/// listeyle. İkisi de parlaksa ayıklama gereksiz (ikinci hat), ikincisi karanlıksa
/// ayıklama yük taşıyor.
#[cfg(target_os = "macos")]
fn flow_exclusion(app: &tauri::AppHandle, m: &MonitorInfo) {
    note("— ayıklama gerçekten iş yapıyor mu —");
    let Some(card) = install_card(app, m, "colors") else {
        check(false, "sınama kartı yerleştirilemedi");
        return;
    };

    on_main(app, |h| crate::capture::start(h, "draw"));
    if !check(wait_overlay(app, "capture-0"), "overlay açıldı (karartma ve donmuş arkalık ekranda)") {
        remove_card(app);
        return;
    }
    lower_main(app);
    sleep(400);

    let ids = crate::capture::overlay_window_ids(app);
    note(&format!("overlay CGWindowID'leri: {ids:?}"));
    if !check(!ids.is_empty(), "overlay'in CGWindowID'si okunabildi") {
        on_main(app, |h| crate::capture::close_all(h, None));
        remove_card(app);
        return;
    }

    // Sol üst çeyrek: bilinen KIRMIZI. Karartma altında kırmızı yarıya iner.
    let (qx, qy, qw, qh) = card.quads_rect(6.0);
    let (rx, ry, rw, rh) = (qx, qy, qw / 2.0, qh / 2.0);

    let with = grab_frame(m, rx, ry, rw, rh, &ids);
    let without = grab_frame(m, rx, ry, rw, rh, &[]);
    on_main(app, |h| crate::capture::close_all(h, None));

    match (with, without) {
        (Some(a), Some(b)) => {
            let ca = sample(&a, 0.5, 0.5);
            let cb = sample(&b, 0.5, 0.5);
            note(&format!("ayıklamalı kare: {} | ayıklamasız kare: {}", hex_of(ca), hex_of(cb)));
            check(ca.0 > 140.0, "ayıklamalı kare kartın gerçek rengini gösteriyor (overlay yok)");
            if cb.0 > 140.0 {
                note(
                    "BULGU: ayıklama listesi BOŞKEN de kare temiz. Overlay `content_protected`                      (NSWindowSharingNone) ile zaten akışa girmiyor; kimlik listesi İKİNCİ HAT.",
                );
            } else {
                note(&format!(
                    "BULGU: ayıklama listesi boşken kare KARARIYOR ({} → {}). Kimlik listesi                      yük taşıyor, tek koruma content_protected değil.",
                    hex_of(ca), hex_of(cb)
                ));
            }
        }
        _ => {
            check(false, "ölçüm: akıştan kare alınamadı");
        }
    }
    remove_card(app);
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

            // ── EMNİYET: galeri kotasını tüketme ──────────────────────────
            //
            // Galeri 30 kayıtla sınırlı ve dolduğunda `gallery::add` EN ESKİSİNİ
            // dosyasıyla birlikte siliyor. Harness eklediğini sonunda temizliyor ama
            // araya giren eviction KULLANICININ kaydını düşürüyor ve geri gelmiyor —
            // 2026-09-06'da tam olarak bu oldu, iki ekran görüntüsü kayboldu.
            //
            // İhtiyaç akış başına sayılıyor, toptan değil: renk, OCR, tıklama
            // geçirgenliği ve ayıklama ölçümü galeriye HİÇ yazmıyor, onlar dolu bir
            // galeride de güvenle koşabilir.
            let adds = |k: &str| match k {
                "tools" => 2,
                "snip" | "scroll" | "multi" | "pointer" | "save" | "a7" => 1,
                _ => 0,
            };
            let needed: usize = wanted.iter().map(|w| adds(w)).sum();
            let free = crate::gallery::MAX_SCREENSHOTS.saturating_sub(gallery_ids(&app).len());
            if needed > free {
                check(
                    false,
                    &format!(
                        "seçilen akışlar galeriye {needed} kayıt yazacak ama yalnız {free} boş yer \
                         var. Koşu DURDURULDU: dolu bir galeride her sınama görüntüsü kullanıcının \
                         en eskisini kalıcı olarak siler. Galeriden yer açın ya da galeriye \
                         yazmayan akışları seçin (color, ocr, through, exclusion)."
                    ),
                );
                println!("QAC SONUC: 1 başarısız");
                sleep(400);
                app.exit(0);
                return;
            }
            if needed > 0 {
                note(&format!("galeri: {needed} kayıt yazılacak, {free} boş yer var"));
            }

            let has = |k: &str| wanted.iter().any(|w| w == k);
            if has("snip") { flow_snip(&app, &m, 0); }
            if has("tools") { flow_tools(&app, &m); }
            if has("color") { flow_color(&app, &m); }
            if has("ocr") { flow_ocr(&app, &m); }
            if has("scroll") { flow_scroll(&app, &m); }
            // İkinci monitör: overlay'in DOĞRU ekrana, doğru ölçekle oturduğu ancak
            // orada seçim yapılıp piksel okunarak kanıtlanabiliyor (bkz. A11).
            // Gerçek imleç isteyen akışlar VARSAYILAN DEĞİL: Erişilebilirlik izni
            // istiyorlar ve çalışırken imleci gerçekten hareket ettiriyorlar.
            #[cfg(target_os = "macos")]
            if has("pointer") || has("save") || has("through") || has("a7") || has("hotkey") || has("firstclick") {
                let trusted = crate::platform::macos::permissions::is_trusted_accessibility(false);
                if !trusted {
                    crate::platform::macos::permissions::is_trusted_accessibility(true);
                    check(false, "Erişilebilirlik izni YOK — sistem diyaloğu açıldı, izni verip UYGULAMAYI YENİDEN BAŞLATIN");
                } else {
                    note("Erişilebilirlik izni var — gerçek imleç kullanılıyor");
                    if has("pointer") { flow_pointer(&app, &m); }
                    if has("save") { flow_savepanel(&app, &m); }
                    if has("a7") { flow_a7(&app, &m); }
                    if has("hotkey") { flow_hotkey(&app, &m); }
                    if has("firstclick") { flow_firstclick(&app, &m); }
                    if has("through") { flow_clickthrough(&app, &m); }
                }
            }

            #[cfg(target_os = "macos")]
            if has("exclusion") { flow_exclusion(&app, &m); }

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
            // Kendiliğinden ÇIK. Harness bittiğinde süreç ayakta kalırsa tek-örnek
            // eklentisi bir sonraki başlatmayı sessizce düşürüyor: ikinci koşu hiçbir
            // şey yazmadan biter ve "test takıldı" gibi görünür. `--shot-save` de
            // aynı şeyi yapıyor. Çıkış store'u da diske indiriyor.
            sleep(400);
            app.exit(0);
        })
        .ok();
}
