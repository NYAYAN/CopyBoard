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

pub fn show(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };

    // Sıra: önce göster, sonra konumlandır (BULGU F1-a).
    let _ = window.show();
    position(app, &window);
    let _ = crate::platform::set_window_level(&window, WindowLevel::ScreenSaver);

    let count = app.state::<AppState>().settings().quick_paste_count();
    super::emit_to(app, LABEL, "quickpaste-show", serde_json::json!({ "count": count }));

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
