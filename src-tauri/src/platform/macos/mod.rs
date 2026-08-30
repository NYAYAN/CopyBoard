//! macOS'a özgü AppKit köprüleri.
//!
//! ## ⚠ Bu dosyadaki TEK kural
//!
//! **AppKit'in her çağrısı ana thread'den yapılır.** Tauri komutları (async ve sync)
//! async runtime'ın worker thread'inde koşar; `NSWindow` API'lerinden birine oradan
//! dokunmak süreci SIGTRAP ile öldürür:
//!
//! ```text
//! asi: libsystem_c.dylib  "Must only be used from the main thread"
//!      AppKit -[NSWindow _applyWindowLevelWithTagUpdateNeeded:]
//! ```
//!
//! (Spike-1'de ölçüldü — bkz. `docs/TAURI_SPIKE_RESULTS.md`, BULGU S1-a.)
//!
//! Bu yüzden dışarıya açılan her fonksiyon gövdesini [`on_main`] içinde çalıştırır.
//! Yeni bir AppKit çağrısı eklerken bu sarmalayıcıyı ATLAMAYIN.

pub mod hotkey_carbon;
pub mod paste;
pub mod permissions;
pub mod pasteboard;

use objc2::rc::Retained;
use objc2_app_kit::{NSApplication, NSWindow, NSWindowCollectionBehavior};
use objc2_foundation::MainThreadMarker;

/// Kapanışı ana thread'de çalıştırır ve sonucunu geri getirir.
fn on_main<F, T>(window: &tauri::WebviewWindow, f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("run_on_main_thread: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| format!("ana thread yanıt vermedi: {e}"))
}

/// Ham `NSWindow`'u güvenle ödünç alır. Pointer'ı closure DIŞINA taşımak yerine
/// pencereyi klonlayıp içeride çözüyoruz — `*mut c_void` `Send` değil.
fn with_ns_window<F, T>(window: &tauri::WebviewWindow, f: F) -> Result<T, String>
where
    F: FnOnce(&NSWindow) -> T + Send + 'static,
    T: Send + 'static,
{
    let w = window.clone();
    on_main(window, move || -> Result<T, String> {
        let ptr = w.ns_window().map_err(|e| e.to_string())?;
        if ptr.is_null() {
            return Err("ns_window() null döndü".into());
        }
        // SAFETY: Tauri bize canlı bir NSWindow pointer'ı veriyor ve bu blok ana
        // thread'de, pencere yaşarken koşuyor.
        let ns: Retained<NSWindow> =
            unsafe { Retained::retain(ptr.cast()) }.ok_or("NSWindow retain başarısız")?;
        Ok(f(&ns))
    })?
}

/// `NSWindow.level` — Electron'un `'screen-saver'` / `'pop-up-menu'` seviyeleri.
pub fn set_ns_level(window: &tauri::WebviewWindow, level: isize) -> Result<(), String> {
    with_ns_window(window, move |ns| ns.setLevel(level))
}

/// Tüm Space'lerde görün, tam ekran uygulamaların üstünde dur, Cmd+Tab döngüsüne girme.
pub fn set_join_all_spaces(window: &tauri::WebviewWindow) -> Result<(), String> {
    with_ns_window(window, |ns| {
        ns.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        )
    })
}

/// Pencereyi diğer pencerelerin üstüne getirir (Electron `moveTop()`).
pub fn order_front(window: &tauri::WebviewWindow) -> Result<(), String> {
    with_ns_window(window, |ns| ns.orderFrontRegardless())
}

/// `vibrancy: 'under-window'` + `visualEffectState: 'active'` karşılığı.
pub fn apply_vibrancy(window: &tauri::WebviewWindow) -> Result<(), String> {
    let w = window.clone();
    on_main(window, move || {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        apply_vibrancy(
            &w,
            NSVisualEffectMaterial::UnderWindowBackground,
            Some(NSVisualEffectState::Active),
            None,
        )
        .map_err(|e| e.to_string())
    })?
}

/// `app.focus({ steal: true })`. Pencereye bağlı değil, ama yine de ana thread ister —
/// bu yüzden çağrı bir `dispatch_async`'e sarılıyor.
pub fn activate_ignoring_other_apps() {
    let Some(mtm) = MainThreadMarker::new() else {
        // Ana thread'de değiliz; AppKit'e dokunmak yasak (bkz. dosya başı).
        log::warn!("activate_app ana thread dışından çağrıldı — atlandı");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
}

/// OS koyu temada mı? `theme: 'system'` bunun üzerine kurulu.
pub fn os_prefers_dark(window: &tauri::WebviewWindow) -> bool {
    window
        .theme()
        .map(|t| matches!(t, tauri::Theme::Dark))
        .unwrap_or(true)
}
