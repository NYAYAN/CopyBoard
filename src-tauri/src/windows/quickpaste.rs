//! Hızlı Yapıştır seçicisi.
//!
//! Global bir kısayolla açılan derli toplu bir pano seçici. **`focusable: false`** ile
//! kuruluyor ki kullanıcının içinde olduğu metin alanından odağı ASLA çalmasın — bir
//! seçimden sonra doğrudan o alana yapıştırabilmemizi sağlayan şey bu (`quickpaste_pick`
//! metni panoya koyup Cmd/Ctrl+V gönderiyor).
//!
//! Esc ile kapanma: pencere `focusable: false` olduğu için tuş vuruşu yakalayamıyor.
//! Esc, YALNIZ görünürken global bir kısayol olarak kaydediliyor ve her gizlenmede
//! bırakılıyor — Esc başka uygulamalara ait, uzun süre tutulmamalı.

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::geom;
use crate::platform::WindowLevel;
use crate::state::AppState;

pub const LABEL: &str = "quickpaste";

const W: f64 = 300.0;
const H: f64 = 380.0;
const GAP: f64 = 12.0;

fn escape_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

pub fn create(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    super::build(
        app,
        super::WindowSpec {
            label: LABEL,
            url: "quickpaste/quickpaste.html",
            width: W,
            height: H,
            transparent: true,
            decorations: false,
            resizable: false,
            shadow: false,
            skip_taskbar: true,
            // Odak ALMAZ — seçicinin tüm mimarisi buna dayanıyor.
            focusable: false,
            always_on_top: true,
            level: Some(WindowLevel::ScreenSaver),
            all_spaces: true,
            background: Some((0, 0, 0, 0)),
            visible: false,
            ..Default::default()
        },
    )
}

/// Seçiciyi imlecin yanına koyar; geçerli ekranın çalışma alanında tamamen kalması
/// için çevrilir/sıkıştırılır.
fn position(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Some((cx, cy)) = geom::cursor_position(app) else { return };
    let Some(m) = geom::monitor_nearest_point(app, cx, cy) else { return };

    let mut x = cx + GAP;
    let mut y = cy + GAP;
    if x + W > m.work_x + m.work_width {
        x = cx - W - GAP; // imlecin SOLUNA çevir
    }
    if y + H > m.work_y + m.work_height {
        y = cy - H - GAP; // imlecin ÜSTÜNE çevir
    }
    let (x, y) = geom::clamp_to_work_area(&m, x, y, W, H, 8.0);
    let _ = geom::place(window, x, y, W, H);
}

static READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PENDING_SHOW: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn emit_show(app: &tauri::AppHandle) {
    let count = app.state::<AppState>().settings().quick_paste_count();
    super::emit_to(app, LABEL, "quickpaste-show", serde_json::json!({ "count": count }));
}

/// Renderer dinleyicilerini kurdu. Bekleyen gösterim varsa şimdi teslim edilir.
pub fn ready(app: &tauri::AppHandle) {
    READY.store(true, std::sync::atomic::Ordering::Release);
    if PENDING_SHOW.swap(false, std::sync::atomic::Ordering::AcqRel) {
        emit_show(app);
    }
}

pub fn show(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };

    // Sıra: önce göster, sonra konumlandır (BULGU F1-a).
    let _ = window.show();
    position(app, &window);
    let _ = crate::platform::set_window_level(&window, WindowLevel::ScreenSaver);
    // Electron her `setAlwaysOnTop(…, 'screen-saver', 1)` çağrısının ardından
    // `moveTop()` da çağırıyordu; seviye tek başına pencereyi diğer topmost
    // pencerelerin ÖNÜNE getirmiyor.
    let _ = crate::platform::order_front(&window);

    // Pencere açılışta ÖNCEDEN kuruluyor, ama `listen()` bir promise: uygulama açılır
    // açılmaz kısayola basılırsa dinleyici henüz kurulmamış olabilir ve gösterim
    // olayı sessizce düşer — seçici boş açılır (BULGU F1-c'nin aynısı).
    // Hazır değilse olay bekletiliyor, `window_ready` gelince teslim ediliyor.
    if READY.load(std::sync::atomic::Ordering::Acquire) {
        emit_show(app);
    } else {
        PENDING_SHOW.store(true, std::sync::atomic::Ordering::Release);
    }

    // Esc yalnız açıkken bizim olsun.
    let handle = app.clone();
    let _ = app.global_shortcut().on_shortcut(escape_shortcut(), move |_a, _s, e| {
        if e.state == ShortcutState::Pressed {
            hide(&handle);
        }
    });

    // Yapıştırma izni ve hedef uygulama, kullanıcı seçim yapmadan hazırlansın.
    if crate::platform::can_paste(true) {
        crate::platform::note_front_app();
    }
}

/// Kaydırma evresi Escape'i geri bıraktığında, seçici hâlâ açıksa onu yeniden kaydeder.
/// İki özellik aynı tuşu paylaştığı için sahiplik el değiştiriyor.
pub fn rearm_escape_if_visible(app: &tauri::AppHandle) {
    let visible = app
        .get_webview_window(LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if !visible {
        return;
    }
    let handle = app.clone();
    let _ = app.global_shortcut().on_shortcut(escape_shortcut(), move |_a, _s, e| {
        if e.state == ShortcutState::Pressed {
            hide(&handle);
        }
    });
}

pub fn hide(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        }
    }
    let _ = app.global_shortcut().unregister(escape_shortcut());
}

pub fn toggle(app: &tauri::AppHandle) {
    match app.get_webview_window(LABEL) {
        Some(w) if w.is_visible().unwrap_or(false) => hide(app),
        Some(_) => show(app),
        None => match create(app) {
            Ok(_) => show(app),
            Err(e) => log::error!("hızlı yapıştır kurulamadı: {e}"),
        },
    }
}
