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
const HISTORY_H: f64 = 400.0;

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
static LIVE_POS: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);

/// Kayıtlı düğme konumu (sürükleme sürüyorsa bellekteki canlı konum).
fn saved_pos(app: &tauri::AppHandle) -> (f64, f64) {
    if let Some(live) = *LIVE_POS.lock().unwrap() {
        return live;
    }
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

pub fn create(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    ensure_in_bounds(app);
    let s = scale(app);
    let (bx, by) = saved_pos(app);
    let side = saved_side(app);

    let window = super::build(
        app,
        super::WindowSpec {
            label: LABEL,
            url: "widget/widget.html",
            width: FULL_W * s,
            height: COLLAPSED_H * s,
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
    let _ = geom::place(&window, window_x(bx, &side, s), by, FULL_W * s, COLLAPSED_H * s);
    let _ = crate::platform::set_window_level(&window, WindowLevel::ScreenSaver);
    let _ = crate::platform::order_front(&window);

    notify_side(app);
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

pub fn notify_side(app: &tauri::AppHandle) {
    super::emit_to(app, LABEL, "widget-side", saved_side(app));
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

/// Panellerin YUKARI açılıp açılmayacağını belirler (düğmenin altında yer yoksa) ve
/// renderer'a bildirir ki düzeni CSS'te aynalasın.
fn compute_direction(app: &tauri::AppHandle, button_y: f64, s: f64) -> bool {
    let Some(m) = geom::monitor_nearest_point(app, saved_pos(app).0, button_y) else {
        return false;
    };
    let space_below = (m.work_y + m.work_height) - button_y;
    let is_up = space_below < HISTORY_H * s;
    super::emit_to(app, LABEL, "widget-direction", is_up);
    is_up
}

/// Aşağı açılırken pencerenin ÜSTÜ sabit; yukarı açılırken DÜĞME sabit (pencere
/// yukarı doğru büyür) — böylece düğme ekranda hiç kıpırdamıyor.
fn top_y_for(base_y: f64, height: f64, is_up: bool, s: f64) -> f64 {
    if is_up { base_y + COLLAPSED_H * s - height } else { base_y }
}

pub fn handle_action(app: &tauri::AppHandle, action: &str, data: Option<serde_json::Value>) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let s = scale(app);
    let (bx, by) = saved_pos(app);
    let side = saved_side(app);
    let win_x = window_x(bx, &side, s);

    let resize = |h_base: f64| {
        let is_up = compute_direction(app, by, s);
        let h = h_base * s;
        let _ = geom::place(&window, win_x, top_y_for(by, h, is_up, s), FULL_W * s, h);
        let _ = crate::platform::set_window_level(&window, WindowLevel::ScreenSaver);
        let _ = crate::platform::order_front(&window);
    };

    match action {
        "expand" => resize(EXPANDED_H),
        "expand-history" => resize(HISTORY_H),
        "collapse-history" => resize(EXPANDED_H),
        "collapse" => {
            let h = COLLAPSED_H * s;
            let _ = geom::place(&window, win_x, by, FULL_W * s, h);
            let _ = crate::platform::set_window_level(&window, WindowLevel::ScreenSaver);
            let _ = crate::platform::order_front(&window);
        }
        "drag" => {
            let dx = data.as_ref().and_then(|d| d.get("x")).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let dy = data.as_ref().and_then(|d| d.get("y")).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let (nx, ny) = (bx + dx, by + dy);
            // Diske DEĞİL belleğe: kalıcı yazma `drag-end`de (`finish_drag`).
            *LIVE_POS.lock().unwrap() = Some((nx.round(), ny.round()));
            let h = window.inner_size().ok().and_then(|z| window.scale_factor().ok().map(|f| z.height as f64 / f))
                .unwrap_or(COLLAPSED_H * s);
            let _ = geom::place(&window, window_x(nx, &side, s), ny, FULL_W * s, h);
            let _ = crate::platform::set_window_level(&window, WindowLevel::ScreenSaver);
            let _ = crate::platform::order_front(&window);
        }
        "drag-end" => finish_drag(app, &window, s),
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

/// Sürükleme bitti: kenarlara yapıştır, ekranda tut, göreli konumu kaydet.
fn finish_drag(app: &tauri::AppHandle, window: &tauri::WebviewWindow, s: f64) {
    let (bx, by) = saved_pos(app);
    // Canlı konum bundan sonra store'a yazılıyor; bellekteki kopya artık gereksiz.
    *LIVE_POS.lock().unwrap() = None;
    let btn = BTN_W * s;
    let col_h = COLLAPSED_H * s;

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

    let _ = geom::place(window, window_x(fx, side, s), fy, FULL_W * s, col_h);
    compute_direction(app, fy, s);
    notify_side(app);
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
    let _ = geom::place(&window, window_x(bx, &side, s), by, FULL_W * s, COLLAPSED_H * s);
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
                update_scale(&inner);
                notify_side(&inner);
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
    fn yukari_acilirken_dugme_yerinde_kaliyor() {
        // Aşağı açılış: pencerenin üstü sabit
        assert_eq!(top_y_for(500.0, 400.0, false, 1.0), 500.0);
        // Yukarı açılış: düğmenin ALTI sabit → üst yukarı kayar
        assert_eq!(top_y_for(500.0, 400.0, true, 1.0), 500.0 + COLLAPSED_H - 400.0);
    }

    #[test]
    fn temel_olculer_css_ile_ayni() {
        assert_eq!(FULL_W, 418.0);
        assert_eq!(COLLAPSED_H, 68.0);
        assert_eq!(PANEL_W, 350.0);
        assert_eq!(BTN_W, 68.0);
    }
}
