//! Yüzen kısayol aracı.
//!
//! ## Koordinat sistemi — dikkat
//!
//! `widgetPos` DÜĞMENİN ölçeklenmemiş mantıksal konumunu saklıyor, pencerenin değil.
//! Pencere düğmeden geniş (panel + düğmeler) ve panel düğmenin hangi tarafında
//! açılacağı `widgetSide`'a bağlı. Yani:
//!
//! ```text
//! sağ tarafta:  pencere.x = düğme.x - panel_genişliği
//! sol tarafta:  pencere.x = düğme.x
//! ```
//!
//! Bu ayrım korunmazsa widget her açılış/kapanışta yana kayar.

use crate::geom;
use crate::platform::WindowLevel;
use crate::state::AppState;
use tauri::Manager;

pub const LABEL: &str = "widget";

/// Ölçeklenmemiş temel ölçüler (`widget.css` ile aynı sayılar).
const PANEL_W: f64 = 350.0;
const BTN_W: f64 = 68.0;
const FULL_W: f64 = PANEL_W + BTN_W; // 418
const COLLAPSED_H: f64 = 68.0;
/// Menü sütunu: 70 px ofset + 6 × 42 px öğe + 5 × 12 px boşluk = 382, artı alt pay.
const EXPANDED_H: f64 = 404.0;
/// Geçmiş paneli: 10 px ofset + 400 px panel + 10 px pay.
///
/// ⚠ 400'dü, yani panelin KENDİ boyu: `top: 10px`le başlayan panelin alt 10 px'i
/// (kenarlığı ve yuvarlak köşeleri) pencerenin dışında kalıp kırpılıyordu; yukarı
/// modda (`bottom: 10px`) aynı şekilde üstü.
const HISTORY_H: f64 = 420.0;
/// Yukarı moddaki pencere boyu — kapalıyken de, menü ya da geçmiş açıkken de AYNI
/// (bkz. [`window_rect`]). En uzun içerik kadar.
const TALL_H: f64 = HISTORY_H;

const SNAP_THRESHOLD: f64 = 60.0;
const MARGIN: f64 = 10.0;

/// Widget içerik zoom'u. Hit-test bunu bilmek zorunda: renderer CSS pikselinde
/// ölçüyor, pencere ise zoom kadar büyük.
pub fn scale(app: &tauri::AppHandle) -> f64 {
    (app.state::<AppState>().settings().widget_scale() as f64 / 100.0).clamp(0.5, 3.0)
}

/// Sürükleme SIRASINDAKİ düğme konumu — yalnız bellekte. Electron `'drag'`de
/// `state.widgetPos`u güncelleyip diski yalnız `'drag-end'`de yazıyordu; portta her
/// kare `config.json`a iniyordu (saniyede onlarca senkron disk yazması).
///
/// Sürükleme sürerken iki konum: (GÖSTERİLEN, HAM).
///
/// Ham konum imleci izliyor ve deltaları sınırsız biriktiriyor; gösterilen konum onun
/// çalışma alanına sıkıştırılmış hâli. İkisi ayrı olmak zorunda: yalnız sıkıştırılmış
/// konumu biriktiren ilk sürüm widget'ı monitör kenarında HAPSEDİYORDU — kenardan
/// 10 px içeride tutulan düğmeye eklenen her küçük delta yine aynı yere sıkıştırılıyor,
/// widget yan monitöre hiç geçemiyordu (ölçüldü: `--widget-race-test`, x=2481'de takıldı,
/// sağ monitör 2560'ta başlıyor). Ham konum sınırı aşınca yan monitörün çalışma alanı
/// devreye giriyor. Diğer bütün işlemler (`saved_pos`) GÖSTERİLEN konumu görüyor.
static LIVE_POS: std::sync::Mutex<Option<((f64, f64), (f64, f64))>> = std::sync::Mutex::new(None);

/// En son BİTEN sürüklemenin kimliği.
///
/// Renderer bırakınca kalan deltayla son bir `drag` ve hemen ardından `drag-end`
/// gönderiyor; `widget_action` async olduğu için ikisi ayrı görevlerde SIRASIZ koşuyor.
/// `drag-end` önce işlendiğinde geç gelen delta, az önce temizlenen canlı konumu yeniden
/// dolduruyordu — onu temizleyecek bir `drag-end` bir daha gelmiyordu ve sonraki her
/// işlem (aç, kapat, yeniden ölçekle) bayat konumdan hesaplanıyordu. Ölçüldü:
/// `--widget-race-test` ile 40 bırakmanın 3-12'sinde. Kimliği biten bir sürüklemenin
/// gecikmiş deltası artık yok sayılıyor; denetim ve yazma `LIVE_POS` kilidi altında.
///
/// ⚠ Ölçüt EŞİTLİK, "en büyükten küçük" değil. Tek bir renderer'dan sürüklemeler ardışık
/// (yeni `pointerdown` öncekinin `pointerup`ından önce gelemez), dolayısıyla geç
/// gelebilecek tek mesaj az önce BİTEN sürüklemeninki. Sıralı bir ölçüt, widget
/// webview'u yeniden yüklendiğinde renderer'ın kimlik sayacı sıfırlandığı için bütün
/// yeni sürüklemeleri yok sayardı. Kimlik renderer'da zaman damgası: yeniden yüklemede
/// de çakışmıyor.
static FINISHED_DRAG: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Paneller yukarı mı açılıyor (düğmenin altında yer yok)?
///
/// Pencerenin ŞEKLİ buna bağlı (bkz. [`window_rect`]), o yüzden yalnız düğme YER
/// DEĞİŞTİRİNCE yeniden hesaplanıyor — bırakınca, açılışta, monitör ya da ölçek
/// değişince. Açarken hesaplamak, açma anında şekil değiştirmek demekti; giderilen
/// flaş tam olarak buydu.
static UP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Test erişimi: sürükleme sonrası canlı konum temizlenmiş mi? (`--widget-race-test`)
#[cfg(debug_assertions)]
pub fn debug_live_pos() -> Option<(f64, f64)> {
    LIVE_POS.lock().unwrap().map(|(shown, _raw)| shown)
}

/// Test erişimi: pencere yukarı modun (uzun) şeklinde mi? Düğme o zaman pencerenin DİBİNDE.
#[cfg(debug_assertions)]
pub fn debug_is_up() -> bool {
    UP.load(std::sync::atomic::Ordering::Acquire)
}

/// Kayıtlı düğme konumu (sürükleme sürüyorsa bellekteki canlı konum).
fn saved_pos(app: &tauri::AppHandle) -> (f64, f64) {
    if let Some((shown, _raw)) = *LIVE_POS.lock().unwrap() {
        return shown;
    }
    stored_pos(app)
}

/// Yalnız depodaki konum (canlı sürükleme konumuna bakmadan). `LIVE_POS` kilidi
/// tutulurken çağrılabilsin diye ayrı: `saved_pos` aynı kilidi yeniden almaya çalışırdı.
fn stored_pos(app: &tauri::AppHandle) -> (f64, f64) {
    let store = &app.state::<AppState>().store;
    let v = store.get_value("widgetPos");
    let x = v.as_ref().and_then(|v| v.get("x")).and_then(|x| x.as_f64());
    let y = v.as_ref().and_then(|v| v.get("y")).and_then(|y| y.as_f64());
    match (x, y) {
        (Some(x), Some(y)) => (x, y),
        _ => {
            let m = geom::primary_monitor(app);
            let w = m.map(|m| m.work_x + m.work_width).unwrap_or(1200.0);
            (w - 80.0, 100.0)
        }
    }
}

fn saved_side(app: &tauri::AppHandle) -> String {
    app.state::<AppState>().store.get("widgetSide", "right".to_string())
}

/// Düğme konumundan PENCERE konumu.
fn window_x(button_x: f64, side: &str, s: f64) -> f64 {
    if side == "left" { button_x } else { button_x - PANEL_W * s }
}

/// Düğmenin altında panellere yer yoksa `true`: paneller yukarı açılır.
fn is_up_on(m: &geom::MonitorInfo, button_y: f64, s: f64) -> bool {
    (m.work_y + m.work_height) - button_y < HISTORY_H * s
}

fn direction_for(app: &tauri::AppHandle, bx: f64, by: f64, s: f64) -> bool {
    geom::monitor_nearest_point(app, bx + BTN_W * s / 2.0, by + COLLAPSED_H * s / 2.0)
        .is_some_and(|m| is_up_on(&m, by, s))
}

/// Pencerenin mantıksal dikdörtgeni `(x, y, w, h)`; `open_h` açık panelin boyu
/// (`COLLAPSED_H` / `EXPANDED_H` / `HISTORY_H`).
///
/// ## Yukarı modda pencere HEP uzun
///
/// Aşağı modda pencere düğmenin üstünden başlıyor ve açılınca AŞAĞI uzuyor: üst kenar
/// sabit, içerik yerinde. Yukarı modda ilk sürüm pencereyi açarken büyütüp YUKARI
/// taşıyordu (düğmenin altı sabit). Ama webview içeriği pencerenin SOL ÜST köşesine
/// bağlı ve yeni boyuta birkaç kare geç çiziliyor: o karelerde eski, kapalı içerik
/// 336 px yukarıdaki yeni üst kenarda göründü — düğme her açılışta yukarı sıçrayıp
/// geri geliyordu, kapanışta aşağı (kullanıcının "menü flash oluyor" dediği). Üstelik
/// `geom::place` önce konumu sonra boyutu veriyor; arada kısa pencere zaten 336 px
/// yukarıda duruyordu.
///
/// Şimdi yukarı modda pencere kapalıyken de açık boyunda duruyor — fazlası saydam ve
/// tıklama-geçirgen (isabet alanı yalnız düğme, bkz. `hit_test.rs`) — ve açmak/kapamak
/// pencereye HİÇ dokunmuyor, yalnız CSS değişiyor. Şekil yalnız düzen (taraf/yön)
/// değişince değişiyor; o geçişi de renderer içeriği gizleyerek örtüyor
/// (bkz. `relayout-ready`).
fn window_rect(bx: f64, by: f64, side: &str, up: bool, open_h: f64, s: f64) -> (f64, f64, f64, f64) {
    let x = window_x(bx, side, s);
    if up {
        let h = TALL_H * s;
        (x, by + COLLAPSED_H * s - h, FULL_W * s, h)
    } else {
        (x, by, FULL_W * s, open_h * s)
    }
}

/// Pencereyi düğme konumuna göre yerleştirir ve üstte tutar.
fn place_window(window: &tauri::WebviewWindow, bx: f64, by: f64, side: &str, up: bool, open_h: f64, s: f64) {
    let (x, y, w, h) = window_rect(bx, by, side, up, open_h, s);
    // Ölçek DÜĞMENİN monitöründen: uzun pencerenin sol üst köşesi komşu (başka ölçekli)
    // monitöre düşebiliyor, widget'ın koordinatları ise düğmenin monitörünün uzayında.
    let _ = geom::place_anchored(window, x, y, w, h, bx + BTN_W * s / 2.0, by + COLLAPSED_H * s / 2.0);
    let _ = crate::platform::set_window_level(window, WindowLevel::ScreenSaver);
    let _ = crate::platform::order_front(window);
}

/// Renderer'a düzeni (taraf + yön) bildirir.
///
/// * `relayout`: pencere ŞEKİL DEĞİŞTİRECEK ama henüz dokunulmadı. Renderer içeriği
///   gizleyip yeni sınıfları uyguluyor ve `relayout-ready` diyor; pencere ancak o zaman
///   yeni şekline giriyor. Aksi hâlde webview'un geç çizdiği karelerde düğme 350 px
///   yanda ya da ~350 px yukarıda/aşağıda görünürdü.
/// * `h`: pencerenin (şimdiki ya da birazdan olacak) CSS yüksekliği — renderer gizlediği
///   içeriği görünüm alanı bu boya ulaşınca açıyor.
fn emit_layout(app: &tauri::AppHandle, relayout: bool, open_h: f64) {
    let up = UP.load(std::sync::atomic::Ordering::Acquire);
    super::emit_to(
        app,
        LABEL,
        "widget-layout",
        serde_json::json!({
            "side": saved_side(app),
            "up": up,
            "relayout": relayout,
            "h": if up { TALL_H } else { open_h },
        }),
    );
}

/// Kapalı hâlin düzenini bildirir (açılış el sıkışması, monitör/ölçek değişimi).
pub fn notify_layout(app: &tauri::AppHandle) {
    emit_layout(app, false, COLLAPSED_H);
}

pub fn create(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    ensure_in_bounds(app);
    let s = scale(app);
    let (bx, by) = saved_pos(app);
    let side = saved_side(app);
    let up = direction_for(app, bx, by, s);
    UP.store(up, std::sync::atomic::Ordering::Release);
    let (_, _, width, height) = window_rect(bx, by, &side, up, COLLAPSED_H, s);

    let window = super::build(
        app,
        super::WindowSpec {
            label: LABEL,
            url: "widget/widget.html",
            width,
            height,
            transparent: true,
            decorations: false,
            resizable: false,
            shadow: false,
            skip_taskbar: true,
            always_on_top: true,
            level: Some(WindowLevel::ScreenSaver),
            all_spaces: true,
            background: Some((0, 0, 0, 0)),
            visible: false,
            ..Default::default()
        },
    )?;

    // Ölçek pencereyi büyütmüyor, İÇERİĞİ büyütüyor.
    let _ = window.set_zoom(s);

    // Electron widget'ı `showInactive()` ile gösteriyordu: yüzen bir araç, kullanıcının
    // yazdığı yerden odağı ÇALMAMALI. `set_focus()` çağırmamak yetmiyor: macOS'ta
    // `show()` zaten `makeKeyAndOrderFront`, Windows'ta aktive eden bir `ShowWindow`
    // yapıyor. `focusable(false)` ile kurulsaydı sürükleme çalışmazdı; o yüzden
    // pencere `platform::show_inactive` ile (orderFrontRegardless / SW_SHOWNOACTIVATE)
    // odak istemeden gösteriliyor.
    if let Err(e) = crate::platform::show_inactive(&window) {
        log::warn!("widget odak almadan gösterilemedi ({e}) — show() ile devam");
        let _ = window.show();
    }
    place_window(&window, bx, by, &side, up, COLLAPSED_H, s);

    // Sayfa henüz yüklenmedi; asıl bildirim `window_ready`de. Renderer o zamana kadar
    // içeriği gizli tutuyor (`layout-pending`): varsayılan sağ/aşağı düzen yukarı
    // moddaki uzun pencerede düğmeyi ~350 px yukarıda çizerdi.
    notify_layout(app);
    push_config(app);
    start_topmost_keeper(app);
    Ok(window)
}

/// Var olan widget'ı ODAK ÇALMADAN geri getirir ve üstte olmasını yeniden dayatır
/// (Electron `showInactive()` + `moveTop()`; yakalama bitişi ve ayar geçişi kullanıyor).
pub fn show_inactive(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    if let Err(e) = crate::platform::show_inactive(&w) {
        log::warn!("widget odak almadan gösterilemedi ({e}) — show() ile devam");
        let _ = w.show();
    }
    let _ = crate::platform::set_window_level(&w, WindowLevel::ScreenSaver);
    let _ = crate::platform::order_front(&w);
}

pub fn toggle(app: &tauri::AppHandle, show: bool) {
    if show {
        if app.get_webview_window(LABEL).is_some() {
            show_inactive(app);
        } else if let Err(e) = create(app) {
            log::error!("widget kurulamadı: {e}");
        }
    } else {
        super::close_if_open(app, LABEL);
    }
}

/// Widget'ın üstte kalmasını periyodik olarak yeniden dayatır.
///
/// 10 sn yeterli: bu yalnız bir emniyet ağı — üstte olma durumu her `show`'da ve her
/// sınır değişiminden sonra da yeniden dayatılıyor, yani aralık nadiren gerçek iş
/// yapıyor. (Electron'da 3 sn'ydi ve süreci boşuna uyandırıyordu.)
fn start_topmost_keeper(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(10));
        let h = handle.clone();
        let alive = handle
            .run_on_main_thread(move || {
                if let Some(w) = h.get_webview_window(LABEL) {
                    if w.is_visible().unwrap_or(false) {
                        let _ = crate::platform::set_window_level(&w, WindowLevel::ScreenSaver);
                        let _ = crate::platform::order_front(&w);
                    }
                }
            })
            .is_ok();
        if !alive {
            RUNNING.store(false, Ordering::Release);
            break;
        }
    });
}

pub fn push_config(app: &tauri::AppHandle) {
    let s = app.state::<AppState>();
    let set = s.settings();
    super::emit_to(
        app,
        LABEL,
        "widget-config",
        serde_json::json!({
            "transparent": set.widget_transparent(),
            "color": set.widget_color(),
            "opacity": set.widget_opacity(),
            "scale": set.widget_scale(),
        }),
    );
}

pub fn handle_action(app: &tauri::AppHandle, action: &str, data: Option<serde_json::Value>) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let s = scale(app);
    let (bx, by) = saved_pos(app);
    let side = saved_side(app);

    // Açma/kapama: yön burada HESAPLANMIYOR (bkz. `UP`). Yukarı modda dikdörtgen her
    // durumda aynı, yani bu çağrı pencereyi yerinden oynatmıyor. Bildirim yalnız emniyet:
    // renderer'ın sınıfları bir şekilde kaçtıysa menü yanlış yöne açılmasın.
    let resize = |open_h: f64| {
        let up = UP.load(std::sync::atomic::Ordering::Acquire);
        place_window(&window, bx, by, &side, up, open_h, s);
        emit_layout(app, false, open_h);
    };

    match action {
        "expand" => resize(EXPANDED_H),
        "expand-history" => resize(HISTORY_H),
        "collapse-history" => resize(EXPANDED_H),
        "collapse" => resize(COLLAPSED_H),
        // Renderer içeriği gizledi ve yeni düzeni uyguladı (bkz. `emit_layout`): pencere
        // şimdi yeni şekline girebilir. Renderer o anki durumunu da söylüyor ki açık bir
        // panel kapalı boya sıkıştırılmasın.
        "relayout-ready" => {
            let open_h = match data.as_ref().and_then(|d| d.get("state")).and_then(|v| v.as_str()) {
                Some("expanded") => EXPANDED_H,
                Some("history") => HISTORY_H,
                _ => COLLAPSED_H,
            };
            resize(open_h);
        }
        "drag" => {
            let num = |k: &str| data.as_ref().and_then(|d| d.get(k)).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let (dx, dy) = (num("x"), num("y"));
            let id = drag_id(&data);
            let btn = BTN_W * s;
            let col_h = COLLAPSED_H * s;
            // Kimlik denetimi, canlı konumun okunması ve yazılması TEK kilit altında:
            // `drag-end` de aynı kilidi alıyor, biri ötekinin ortasına giremiyor.
            let placed = {
                let mut live = LIVE_POS.lock().unwrap();
                if id != 0 && id == FINISHED_DRAG.load(std::sync::atomic::Ordering::Acquire) {
                    None // bu sürükleme bitti; gecikmiş delta
                } else {
                    // Delta HAM konuma ekleniyor (bkz. LIVE_POS): sıkıştırılmış konuma
                    // eklenseydi widget monitör kenarında takılırdı.
                    let (rx, ry) = live.map(|(_shown, raw)| raw).unwrap_or_else(|| stored_pos(app));
                    let (tx, ty) = (rx + dx, ry + dy);
                    // Sürükleme SIRASINDA da çalışma alanında tut. Yalnız bırakınca
                    // sıkıştırılıyordu: aşağı sürüklenen widget'ın yarısı görev çubuğunun
                    // ALTINA giriyor (ölçüldü: 40/40), bırakınca da yukarı zıplıyordu.
                    // Monitör SIKIŞTIRILMAMIŞ hedeften seçiliyor — sınırı geçen sürükleme
                    // yan monitöre atlayabilsin.
                    let (cx, cy) = match geom::monitor_nearest_point(app, tx + btn / 2.0, ty + col_h / 2.0) {
                        Some(m) => geom::clamp_to_work_area(&m, tx, ty, btn, col_h, MARGIN),
                        None => (tx, ty),
                    };
                    // Diske DEĞİL belleğe: kalıcı yazma `drag-end`de (`finish_drag`).
                    *live = Some(((cx.round(), cy.round()), (tx, ty)));
                    Some((cx, cy))
                }
            };
            if let Some((nx, ny)) = placed {
                // Sürüklenirken pencere düzenin KAPALI şeklinde (renderer da sürükleme
                // başlayınca paneli kapatıyor, widget.js). Düzen — dolayısıyla şekil —
                // sürükleme boyunca SABİT: taraf ve yön bırakınca yeniden hesaplanıyor;
                // sürüklerken şekil değiştirmek düğmeyi her eşik geçişinde bir an
                // yanlış yerde gösterirdi.
                let up = UP.load(std::sync::atomic::Ordering::Acquire);
                place_window(&window, nx, ny, &side, up, COLLAPSED_H, s);
            }
        }
        "drag-end" => {
            let id = drag_id(&data);
            let pos = {
                let mut live = LIVE_POS.lock().unwrap();
                if id != 0 {
                    FINISHED_DRAG.store(id, std::sync::atomic::Ordering::Release);
                }
                // HAM konum: `finish_drag` monitörü imlecin gerçekten bulunduğu yerden
                // seçip kendisi sıkıştırıyor ve kenara yapıştırıyor.
                live.take().map(|(_shown, raw)| raw)
            };
            finish_drag(app, &window, s, pos);
        }
        "open-list" => crate::windows::main_window::show(app),
        "note-front-app" => crate::platform::note_front_app(),
        "quickpaste" => super::quickpaste::toggle(app),
        "capture-draw" => crate::capture::start(app, "draw"),
        "capture-ocr" => crate::capture::start(app, "ocr"),
        "capture-video" => crate::capture::start(app, "video"),
        "capture-scroll" => crate::capture::start(app, "scroll"),
        other => log::warn!("bilinmeyen widget eylemi: {other}"),
    }
}

/// Renderer'ın her sürüklemeye verdiği kimlik (yoksa 0 — eski renderer, denetim yok).
fn drag_id(data: &Option<serde_json::Value>) -> u64 {
    data.as_ref().and_then(|d| d.get("id")).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Sürükleme bitti: kenarlara yapıştır, ekranda tut, göreli konumu kaydet.
///
/// `pos`: çağıranın `LIVE_POS` kilidi altında ALDIĞI canlı konum (yoksa depodaki).
fn finish_drag(app: &tauri::AppHandle, window: &tauri::WebviewWindow, s: f64, pos: Option<(f64, f64)>) {
    let (bx, by) = pos.unwrap_or_else(|| stored_pos(app));
    let btn = BTN_W * s;
    let col_h = COLLAPSED_H * s;
    // Sürükleme boyunca geçerli olan düzen: değişip değişmediğine bakılacak.
    let prev_side = saved_side(app);
    let prev_up = UP.load(std::sync::atomic::Ordering::Acquire);

    let Some(m) = geom::monitor_nearest_point(app, bx + btn / 2.0, by + col_h / 2.0) else {
        // Monitör bulunamadı: en azından sürüklenen konum kaybolmasın.
        let store = &app.state::<AppState>().store;
        store.set("widgetPos", serde_json::json!({ "x": bx.round(), "y": by.round() }));
        return;
    };

    let mut fx = bx;
    let mut fy = by;
    if (fx - m.work_x).abs() < SNAP_THRESHOLD {
        fx = m.work_x + MARGIN;
    } else if (fx - (m.work_x + m.work_width - btn)).abs() < SNAP_THRESHOLD {
        fx = m.work_x + m.work_width - btn - MARGIN;
    }
    if (fy - m.work_y).abs() < SNAP_THRESHOLD {
        fy = m.work_y + MARGIN;
    } else if (fy - (m.work_y + m.work_height - col_h)).abs() < SNAP_THRESHOLD {
        fy = m.work_y + m.work_height - col_h - MARGIN;
    }
    let (fx, fy) = geom::clamp_to_work_area(&m, fx, fy, btn, col_h, MARGIN);

    let side = if fx < m.work_x + m.work_width / 2.0 { "left" } else { "right" };
    let store = &app.state::<AppState>().store;
    store.set("widgetPos", serde_json::json!({ "x": fx.round(), "y": fy.round() }));
    store.set("widgetSide", side);
    // Göreli konum: monitörler değiştiğinde widget'ı aynı köşede tutmanın tek yolu.
    store.set(
        "widgetDockParams",
        serde_json::json!({
            "relX": (fx - m.work_x) / (m.work_width - btn).max(1.0),
            "relY": (fy - m.work_y) / (m.work_height - col_h).max(1.0),
            "side": side,
            // Widget'ın yerleştiği FİZİKSEL ekran — bkz. `ensure_in_bounds`.
            "displayName": m.name,
        }),
    );

    let up = is_up_on(&m, fy, s);
    UP.store(up, std::sync::atomic::Ordering::Release);
    if side == prev_side && up == prev_up {
        // Şekil aynı: yalnız taşınma (kenara yapışma), içerik pencereyle birlikte gidiyor.
        place_window(window, fx, fy, side, up, COLLAPSED_H, s);
        emit_layout(app, false, COLLAPSED_H);
    } else {
        // Şekil değişiyor (kısa ↔ uzun ya da sağ ↔ sol). Pencere renderer içeriği gizleyip
        // `relayout-ready` diyene kadar son sürükleme konumunda bekliyor; renderer o
        // onayı bir emniyet süresiyle de gönderiyor, yani burada beklemek takılmıyor.
        emit_layout(app, true, COLLAPSED_H);
    }
}

/// Widget'ın en az bir mevcut monitörde olduğundan emin olur. Geçişler sırasında
/// kararlılık için göreli koordinatları kullanıyor.
pub fn ensure_in_bounds(app: &tauri::AppHandle) {
    let s = scale(app);
    let btn = BTN_W * s;
    let (bx, by) = saved_pos(app);

    let store = &app.state::<AppState>().store;
    let dock = store.get_value("widgetDockParams");

    // Hedef monitör seçimi — Electron'un sırasını izliyor:
    //   1. Kayıtlı konum bir monitörün İÇİNDEyse o monitör (`getDisplayMatching`).
    //   2. Değilse, widget'ın en son yerleştiği EKRAN ADI hâlâ bağlıysa o
    //      (Electron'un `dockParams.displayId` yedeği).
    //   3. O da yoksa en yakın monitör, sonra birincil.
    //
    // 2. adım olmadan şu yaşanıyordu: dizüstü harici ekranla kullanılıyor, widget
    // sağdaki ekranda; kapak kapanıp açılınca ya da ekran uykudan geç dönünce widget
    // "en yakın" monitöre, yani yanlış ekrana taşınıyor ve orada KALIYORDU — çünkü
    // taşındıktan sonra kayıtlı konum da yeni ekranı gösteriyor.
    let monitors = geom::all_monitors(app);
    let saved_name = dock
        .as_ref()
        .and_then(|d| d.get("displayName")?.as_str().map(str::to_string));
    let m = monitors
        .iter()
        .find(|m| m.contains(bx, by))
        .or_else(|| {
            saved_name
                .as_deref()
                .and_then(|want| monitors.iter().find(|m| m.name.as_deref() == Some(want)))
        })
        .cloned()
        .or_else(|| geom::monitor_nearest_point(app, bx, by))
        .or_else(|| geom::primary_monitor(app));
    let Some(m) = m else { return };

    let rel = dock.as_ref().and_then(|d| {
        Some((d.get("relX")?.as_f64()?, d.get("relY")?.as_f64()?))
    });

    let (mut nx, mut ny) = match rel {
        Some((rx, ry)) => (
            m.work_x + rx * (m.work_width - btn).max(1.0),
            m.work_y + ry * (m.work_height - btn).max(1.0),
        ),
        None => (bx, by),
    };
    let clamped = geom::clamp_to_work_area(&m, nx, ny, btn, btn, MARGIN);
    nx = clamped.0;
    ny = clamped.1;

    let side = if nx < m.work_x + m.work_width / 2.0 { "left" } else { "right" };
    store.set("widgetPos", serde_json::json!({ "x": nx.round(), "y": ny.round() }));
    store.set("widgetSide", side);
    store.set(
        "widgetDockParams",
        serde_json::json!({
            "relX": (nx - m.work_x) / (m.work_width - btn).max(1.0),
            "relY": (ny - m.work_y) / (m.work_height - btn).max(1.0),
            "side": side,
            "displayName": m.name,
        }),
    );
}

/// Ölçek ayarı değişti: içerik zoom'unu ve pencere ölçüsünü tazele.
pub fn update_scale(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let s = scale(app);
    let _ = window.set_zoom(s);
    let (bx, by) = saved_pos(app);
    let side = saved_side(app);
    // Eşik ölçekle değişiyor (`HISTORY_H * s`) ve monitör değişiminde konum da değişmiş
    // olabilir: yön yeniden hesaplanmalı. Seyrek olaylar; şekil değişimi örtülmüyor.
    let up = direction_for(app, bx, by, s);
    UP.store(up, std::sync::atomic::Ordering::Release);
    place_window(&window, bx, by, &side, up, COLLAPSED_H, s);
    notify_layout(app);
    push_config(app);
}

/// Monitör değişimlerini izler ve widget'ı ekranda tutar.
///
/// ## Neden yoklama, olay değil
///
/// Electron `screen.on('display-added' | 'display-removed' | 'display-metrics-changed')`
/// dinliyordu. Tauri'de bunun doğrudan karşılığı yok; macOS'ta
/// `NSApplicationDidChangeScreenParametersNotification` için bir Objective-C sınıfı
/// tanımlamak gerekiyor. Monitör düzeni saniyede bir kez bile değişmediği için
/// düşük frekanslı bir parmak izi karşılaştırması yeterli ve taşınabilir.
///
/// Bu bağlanmadığında widget, artık var olmayan koordinatlarda kalıp görünmez ve
/// tıklanamaz oluyordu — kurtuluşu yalnız uygulamayı yeniden başlatmaktı.
pub fn start_display_watcher(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }

    fn fingerprint(app: &tauri::AppHandle) -> String {
        crate::geom::all_monitors(app)
            .iter()
            .map(|m| format!("{:.0},{:.0},{:.0},{:.0},{:.2}", m.x, m.y, m.width, m.height, m.scale))
            .collect::<Vec<_>>()
            .join("|")
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut last = fingerprint(&handle);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let now = fingerprint(&handle);
            if now == last {
                continue;
            }
            log::info!("monitör düzeni değişti — widget yeniden yerleştiriliyor");
            last = now;
            handle_display_change(&handle);
        }
    });
}

/// Monitör eklendi/çıkarıldı/yeniden boyutlandı.
pub fn handle_display_change(app: &tauri::AppHandle) {
    // Üçlü kontrol: çok monitörlü geçişler sırasında OS'un yeniden yerleşimlerini yakala.
    // Electron her olayda birikmiş timeout'ları İPTAL ediyordu; olay yağmurunda
    // thread yığılmasını nesil sayacı engelliyor.
    let generation = SYNC_GENERATION.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
    for delay in [500u64, 2000, 5000] {
        let h = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            if SYNC_GENERATION.load(std::sync::atomic::Ordering::Acquire) != generation {
                return; // daha yeni bir değişim var; bu tur geçersiz
            }
            let inner = h.clone();
            let _ = h.run_on_main_thread(move || {
                if inner.get_webview_window(LABEL).is_none() {
                    return;
                }
                ensure_in_bounds(&inner);
                // Yönü yeniden hesaplıyor, yerleştiriyor ve düzeni bildiriyor.
                update_scale(&inner);
            });
        });
    }
}

static SYNC_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pencere_x_dugme_konumundan_turuyor() {
        // Bu ayrım korunmazsa widget her açılış/kapanışta yana kayar.
        assert_eq!(window_x(1000.0, "left", 1.0), 1000.0);
        assert_eq!(window_x(1000.0, "right", 1.0), 1000.0 - PANEL_W);
        // Ölçek panele uygulanır
        assert_eq!(window_x(1000.0, "right", 2.0), 1000.0 - PANEL_W * 2.0);
    }

    #[test]
    fn asagi_modda_ust_kenar_sabit_pencere_asagi_uzuyor() {
        for open_h in [COLLAPSED_H, EXPANDED_H, HISTORY_H] {
            let (x, y, w, h) = window_rect(1000.0, 500.0, "right", false, open_h, 1.0);
            assert_eq!((x, y, w, h), (1000.0 - PANEL_W, 500.0, FULL_W, open_h));
        }
    }

    #[test]
    fn yukari_modda_acma_kapama_pencereyi_oynatmiyor() {
        // Flaşın kökü buydu: yukarı açılırken pencere hem büyüyüp hem yukarı taşınıyordu ve
        // webview yeni şekle geç çizdiği için düğme bir an 336 px yukarıda görünüyordu.
        // Kapalı, menü ve geçmiş için dikdörtgen BİREBİR aynı olmalı.
        for s in [0.5, 1.0, 1.25, 2.0] {
            let kapali = window_rect(1000.0, 900.0, "left", true, COLLAPSED_H, s);
            for open_h in [EXPANDED_H, HISTORY_H] {
                assert_eq!(window_rect(1000.0, 900.0, "left", true, open_h, s), kapali, "ölçek {s}");
            }
            // Düğme pencerenin DİBİNDE ve ekranda kayıtlı konumunda duruyor.
            let (_, y, _, h) = kapali;
            assert!((y + h - COLLAPSED_H * s - 900.0).abs() < 1e-9, "ölçek {s}");
        }
    }

    #[test]
    fn uzun_pencere_en_uzun_icerik_kadar() {
        assert!(TALL_H >= EXPANDED_H);
        assert!(TALL_H >= HISTORY_H);
        // Geçmiş paneli widget.css'te `top/bottom: 10px` + 400 px: pencere en az 410 olmalı.
        assert!(HISTORY_H >= 410.0);
    }

    #[test]
    fn yon_esigi_panelin_asagi_sigmasina_gore() {
        let m = geom::MonitorInfo {
            x: 0.0, y: 0.0, width: 1920.0, height: 1080.0,
            work_x: 0.0, work_y: 0.0, work_width: 1920.0, work_height: 1032.0,
            scale: 1.0, name: None,
        };
        // Altta geçmiş paneline yer var → aşağı; yoksa → yukarı.
        assert!(!is_up_on(&m, 1032.0 - HISTORY_H, 1.0));
        assert!(is_up_on(&m, 1032.0 - HISTORY_H + 1.0, 1.0));
        // Ölçek eşiği büyütüyor.
        assert!(is_up_on(&m, 1032.0 - HISTORY_H, 1.5));
    }

    #[test]
    fn temel_olculer_css_ile_ayni() {
        assert_eq!(FULL_W, 418.0);
        assert_eq!(COLLAPSED_H, 68.0);
        assert_eq!(PANEL_W, 350.0);
        assert_eq!(BTN_W, 68.0);
    }
}
