//! Pencere fabrikası — `src/main/services/window-manager.js`'in karşılığı.
//!
//! Electron'da her pencere `new BrowserWindow({...})` ile kendi bayrak listesini
//! taşıyordu ve `preload.js` her birine `window.api`'yi veriyordu. Burada tek bir
//! [`build`] fonksiyonu var; farklar [`WindowSpec`]'te.
//!
//! ## `initialization_script` — senkron preload'un yerine
//!
//! Electron preload'u sözlüğü ve temayı `ipcRenderer.sendSync` ile sayfa scriptleri
//! ÇALIŞMADAN ÖNCE alıyordu; `shared/theme.js` bu yüzden `<html data-theme>` bayrağını
//! ilk karede basabiliyor ve hiçbir pencere önce koyu sonra açık diye titremiyordu.
//!
//! Tauri'de senkron IPC yok. `initialization_script` sayfanın kendi scriptlerinden önce
//! çalışıyor (Spike-7'de altı pencerede ölçüldü) ve aynı veriyi `window.__COPYBOARD_BOOT__`
//! olarak bırakıyor. `api-tauri.js` bunu okuyup `window.api.i18n` / `.theme` diye sunuyor.

pub mod capture;
pub mod hit_test;
pub mod main_window;
pub mod quickpaste;
pub mod widget;
pub mod update;
pub mod toast;
pub mod viewer;

use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::platform::{self, WindowLevel};
use crate::state::AppState;
use crate::{i18n, theme};

/// Bir pencerenin Electron'daki `BrowserWindow` seçeneklerine karşılık gelen tarifi.
pub struct WindowSpec {
    pub label: &'static str,
    /// `src/renderer` altındaki HTML yolu, ör. `"main-window/index.html"`.
    pub url: &'static str,
    pub width: f64,
    pub height: f64,
    pub transparent: bool,
    pub decorations: bool,
    pub resizable: bool,
    pub shadow: bool,
    pub skip_taskbar: bool,
    pub focusable: bool,
    pub always_on_top: bool,
    pub level: Option<WindowLevel>,
    pub all_spaces: bool,
    pub content_protected: bool,
    pub background: Option<(u8, u8, u8, u8)>,
    pub visible: bool,
}

impl Default for WindowSpec {
    fn default() -> Self {
        Self {
            label: "window",
            url: "main-window/index.html",
            width: 400.0,
            height: 300.0,
            transparent: false,
            decorations: false,
            resizable: false,
            shadow: true,
            skip_taskbar: true,
            focusable: true,
            always_on_top: false,
            level: None,
            all_spaces: false,
            content_protected: false,
            background: None,
            visible: false,
        }
    }
}

/// Açılış verisinin kendisi (JSON). Dil değişiminde `sessionStorage`'a da bu yazılıyor.
pub fn boot_payload(app: &tauri::AppHandle, os_is_dark: bool) -> serde_json::Value {
    let state = app.state::<AppState>();
    let store = &state.store;
    let lang = i18n::get_language(store);

    serde_json::json!({
        "platform": if cfg!(target_os = "macos") { "darwin" }
                    else if cfg!(target_os = "windows") { "win32" }
                    else { "linux" },
        "i18n": { "lang": lang, "dict": i18n::dict_for(&lang) },
        "theme": { "mode": theme::get_mode(store), "resolved": theme::resolved(store, os_is_dark) },
    })
}

/// Sayfa scriptlerinden ÖNCE enjekte edilen açılış verisi.
///
/// `sessionStorage`'daki değer TERCİH EDİLİYOR. Sebebi: `initialization_script`
/// pencere kurulurken sabitleniyor ve her `location.reload()`'da AYNI eski değerle
/// yeniden çalışıyor. Dil değişimi reload gerektirdiği için, taze yükü reload'dan
/// önce `sessionStorage`'a yazıp burada okumak, değişimin reload'dan sağ çıkmasının
/// tek yolu (bkz. `commands::core::set_language`).
pub fn boot_script(app: &tauri::AppHandle, os_is_dark: bool) -> String {
    let boot = boot_payload(app, os_is_dark);
    format!(
        "(function () {{ \
           var d = {boot}; \
           try {{ var s = sessionStorage.getItem('__COPYBOARD_BOOT__'); if (s) d = JSON.parse(s); }} catch (e) {{}} \
           window.__COPYBOARD_BOOT__ = d; \
         }})();"
    )
}

/// Tarifi gerçek bir pencereye çevirir. Bayrak sonrası ayarlar (seviye, vibrancy,
/// Space davranışı) pencere kurulduktan SONRA uygulanır — hepsi AppKit'e dokunuyor
/// ve `platform::macos` bunları ana thread'e yönlendiriyor.
pub fn build(app: &tauri::AppHandle, spec: WindowSpec) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(spec.label) {
        return Ok(existing);
    }

    // `theme: 'system'` için OS görünümü. Var olan bir pencereden (`Window::theme()`)
    // ya da pencere yoksa doğrudan OS'tan (`platform::os_prefers_dark_hint`). İlk hâli
    // burada `true` sabitliyordu ve "aşağıda düzeltilir" diyordu — düzelten kod yoktu;
    // açık temalı bir OS'ta Sistem modu her pencereyi koyu açıyordu.
    let os_is_dark = crate::commands::core::os_prefers_dark(app);
    let mut b = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        // Başlık çerçevesiz pencerede görünmüyor ama BOŞ DEĞİL: ekran paylaşım
        // seçicileri, Görev Yöneticisi ve erişilebilirlik ağacı bunu gösteriyor —
        // verilmezse wry "Tauri App" yazıyor.
        //
        // Yakalama filtresi buna BAKMIYOR. Bir zamanlar bakıyordu ("başlığı CopyBoard
        // içeren pencereler") ve her pencerenin başlığı bu olduğu için filtre
        // overlay'i değil uygulamanın TAMAMINI siliyordu: CopyBoard kendi geçmişini
        // ya da galerisini kaydedemiyordu. Ayıklama artık overlay'in CGWindowID'siyle
        // yapılıyor (bkz. `capture::overlay_window_ids`) — başlık serbest.
        .title("CopyBoard")
        .initialization_script(boot_script(app, os_is_dark))
        .inner_size(spec.width, spec.height)
        .decorations(spec.decorations)
        .resizable(spec.resizable)
        .shadow(spec.shadow)
        .skip_taskbar(spec.skip_taskbar)
        .focusable(spec.focusable)
        .transparent(spec.transparent)
        .content_protected(spec.content_protected)
        .visible(spec.visible);

    if spec.always_on_top {
        b = b.always_on_top(true);
    }
    if let Some((r, g, bl, a)) = spec.background {
        b = b.background_color(tauri::window::Color(r, g, bl, a));
    }

    let window = b.build().map_err(|e| format!("{} penceresi kurulamadı: {e}", spec.label))?;

    if let Some(level) = spec.level {
        if let Err(e) = platform::set_window_level(&window, level) {
            log::warn!("{}: pencere seviyesi ayarlanamadı: {e}", spec.label);
        }
    }
    // OS görünümü değiştiğinde 'sistem' modundaki pencereler takip etmeli.
    // Electron'da `nativeTheme.on('updated')` bunu yapıyordu; Tauri'de karşılığı
    // pencere başına `ThemeChanged` olayı.
    {
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::ThemeChanged(_)) {
                crate::commands::core::broadcast_theme(&handle);
            }
        });
    }

    if spec.all_spaces {
        if let Err(e) = platform::join_all_spaces(&window) {
            log::warn!("{}: tüm masaüstlerinde görünürlük ayarlanamadı: {e}", spec.label);
        }
    }

    Ok(window)
}

/// Bir pencereye olay yollar. Etiket yoksa sessizce hiçbir şey yapmaz —
/// Electron'daki `win && !win.isDestroyed()` kalıbının karşılığı.
pub fn emit_to(app: &tauri::AppHandle, label: &str, event: &str, payload: impl serde::Serialize + Clone) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window(label) {
        if let Err(e) = w.emit_to(label, event, payload) {
            log::warn!("{label} penceresine '{event}' gönderilemedi: {e}");
        }
    }
}

/// Yalnız GÖRÜNÜR pencerelere yollar. Gizli pencereler gösterildiklerinde veriyi
/// kendileri tazeliyor; her pano kopyasında ~0.5 MB geçmişi üç pencereye itmek
/// saf israftı (Electron sürümündeki `broadcast()` optimizasyonu).
pub fn emit_to_visible(
    app: &tauri::AppHandle,
    labels: &[&str],
    event: &str,
    payload: impl serde::Serialize + Clone,
) {
    use tauri::Emitter;
    for label in labels {
        if let Some(w) = app.get_webview_window(label) {
            if w.is_visible().unwrap_or(false) {
                let _ = w.emit_to(*label, event, payload.clone());
            }
        }
    }
}

// ── Etikete göre güvenli pencere işlemleri ───────────────────────────────────
// Electron'daki `win && !win.isDestroyed()` kalıbının karşılığı: pencere yoksa
// çağrılar sessizce hiçbir şey yapmıyor.

pub fn close_if_open(app: &tauri::AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.close();
    }
}

pub fn hide_if_open(app: &tauri::AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.hide();
    }
}

pub fn show_if_open(app: &tauri::AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
    }
}

/// Tüm pencerelere yayınlar.
pub fn emit_all(app: &tauri::AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
    use tauri::Emitter;
    if let Err(e) = app.emit(event, payload) {
        log::warn!("'{event}' yayınlanamadı: {e}");
    }
}
