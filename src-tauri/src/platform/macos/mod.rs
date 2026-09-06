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
pub mod audio_devices;
pub mod pasteboard;
pub mod power;

use objc2::rc::Retained;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWindow,
    NSWindowCollectionBehavior,
};
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

/// Pencerenin CGWindowID'si.
///
/// macOS'ta `NSWindow.windowNumber` ile CGWindowID AYNI sayıdır, yani
/// ScreenCaptureKit'in `SCWindow.window_id`'siyle doğrudan karşılaştırılabilir.
/// Yakalama filtresi overlay'i BAŞLIKLA değil bununla ayıklıyor: uygulamanın her
/// penceresinin başlığı "CopyBoard" (bkz. `windows::build`) ve başlığa bakan bir
/// filtre CopyBoard'un kendi arayüzünü de akıştan siliyordu.
pub fn window_id(window: &tauri::WebviewWindow) -> Result<u32, String> {
    let number = with_ns_window(window, |ns| ns.windowNumber())?;
    // AppKit ekran aygıtı olmayan pencereye 0 ya da negatif veriyor. 0'ı sessizce
    // `0u32`ye çevirmek en kötü sonucu doğururdu: liste dolu görünür ama hiçbir
    // SCWindow'la eşleşmez, yani overlay dışlanmadan akışa girer.
    if number <= 0 {
        return Err(format!("pencerenin ekran aygıtı yok (windowNumber={number})"));
    }
    u32::try_from(number).map_err(|_| format!("pencere numarası CGWindowID değil: {number}"))
}

/// Hata ayıklama ölçümü: uygulama AKTİF mi, pencere KEY mi?
///
/// "İlk tıklama yutuluyor" raporunda tahmin yürütmemek için. Bir pencere key
/// değilse `mouseMoved` hiç almıyor (kullanıcının "renk göstergesi fareyi takip
/// etmiyor" dediği şey) ve ilk tıklama pencereyi uyandırmaya harcanıyor.
#[cfg(debug_assertions)]
pub fn focus_state(window: &tauri::WebviewWindow) -> Result<(bool, bool), String> {
    let mtm = MainThreadMarker::new().ok_or("ana thread değil")?;
    let active = NSApplication::sharedApplication(mtm).isActive();
    let key = with_ns_window(window, |ns| ns.isKeyWindow())?;
    Ok((active, key))
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

/// Pencereyi ODAK ALMADAN gösterir (Electron `showInactive()`).
///
/// tao'nun `set_visible(true)`i `makeKeyAndOrderFront` çağırıyor — pencere key olur,
/// CopyBoard aktif uygulama olur, kullanıcının yazdığı alan odağı kaybeder.
/// `orderFrontRegardless` pencereyi görünür kılıp öne getirir ama key YAPMAZ.
pub fn show_inactive(window: &tauri::WebviewWindow) -> Result<(), String> {
    with_ns_window(window, |ns| ns.orderFrontRegardless())
}

/// OS görünümü koyu mu — pencere olmadan, `NSApp.effectiveAppearance` üzerinden.
/// Ana thread dışından çağrılırsa `None` (AppKit kuralı).
pub fn os_prefers_dark_hint() -> Option<bool> {
    // Ana thread dışından `None` dönüyor ve çağıran taraf bunu "okunamadı" sanıp
    // KOYU varsayıyor (`os_prefers_dark`: `unwrap_or(true)`) — açık temalı bir
    // makinede ilk pencere koyu açılırdı. Sessiz kalmasın.
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("os_prefers_dark_hint ana thread dışından çağrıldı — tercih okunamadı");
        return None;
    };
    let app = NSApplication::sharedApplication(mtm);
    let name = app.effectiveAppearance().name();
    Some(name.to_string().contains("Dark"))
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
    // ── Neden İKİ yol ────────────────────────────────────────────────────
    //
    // `activateIgnoringOtherApps` macOS 14'ten beri kullanımdan kalkmış durumda ve
    // yeni sürümlerde çoğu zaman YOK SAYILIYOR: sistem, arka plandaki bir uygulamanın
    // odağı kendiliğinden çalmasını engelliyor. Ölçümde bu, yakalama overlay'inin
    // aralıklı olarak aktif olamamasına yol açtı — kullanıcı ilk tıklamasını
    // pencereyi uyandırmaya harcıyordu ve fare imleci bile takip etmiyordu.
    //
    // Belgelenen güncel yol `NSRunningApplication.activate(options:)`. Eski çağrı
    // da bırakıldı: ikisi birlikte hem yeni hem eski sürümleri kapsıyor ve
    // ikisinin de yan etkisi yok.
    let running = NSRunningApplication::currentApplication();
    running.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);

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
