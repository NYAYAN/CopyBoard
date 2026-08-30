//! İşletim sistemine özgü, Tauri'nin kapsamadığı davranışlar.
//!
//! Her modül `cfg` ile korunuyor ve dışarıya AYNI imzayı sunuyor; çağıran taraf
//! `#[cfg]` yazmıyor. Desteklenmeyen platformda çağrılar sessizce başarısız olur
//! (`Err`) — bu davranışlar iyileştirme, ön koşul değil.

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

/// Electron `BrowserWindow.setAlwaysOnTop(win, level)` seviyeleri.
///
/// Tauri'nin `set_always_on_top(true)`'su macOS'ta yalnız `NSFloatingWindowLevel` (3)
/// verir; CopyBoard'un overlay'i, widget'ı, toast'ı ve hızlı yapıştırı bunun çok
/// üstünde durmak zorunda.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowLevel {
    /// Electron `'screen-saver'` — widget, toast, hızlı yapıştır, ana pencere.
    ScreenSaver,
    /// Electron `'pop-up-menu'` — yakalama overlay'i.
    PopUpMenu,
}

impl WindowLevel {
    /// macOS `NSWindow.level` karşılığı.
    pub fn ns_level(self) -> isize {
        match self {
            WindowLevel::ScreenSaver => 1000, // NSScreenSaverWindowLevel
            WindowLevel::PopUpMenu => 101,    // NSPopUpMenuWindowLevel
        }
    }
}

/// Pencereyi verilen seviyeye çıkarır. macOS dışında `always_on_top` zaten yeterli.
pub fn set_window_level(window: &tauri::WebviewWindow, level: WindowLevel) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::set_ns_level(window, level.ns_level())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = level;
        window.set_always_on_top(true).map_err(|e| e.to_string())
    }
}

/// Pencerenin TÜM masaüstlerinde ve tam ekran uygulamaların ÜSTÜNDE görünmesi.
///
/// Tauri'nin `set_visible_on_all_workspaces` çağrısı macOS'ta `fullScreenAuxiliary`
/// bayrağını set etmiyor (tauri#11488), bu yüzden `collectionBehavior` elle yazılıyor.
pub fn join_all_spaces(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_visible_on_all_workspaces(true)
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        macos::set_join_all_spaces(window)?;
    }
    Ok(())
}

/// macOS'ta Dock simgesini gizler (Electron `app.dock.hide()`).
pub fn hide_dock(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// Uygulamayı öne getirir (Electron `app.focus({ steal: true })`).
///
/// Dock gizli olduğu için (accessory app) `show()` + `focus()` tek başına CopyBoard'u
/// aktif uygulama yapmaya yetmez ve yeni pencere odağı hemen kaybedebilir.
pub fn activate_app() {
    #[cfg(target_os = "macos")]
    {
        macos::activate_ignoring_other_apps();
    }
}

// ── Pano ─────────────────────────────────────────────────────────────────────
// Her iki platformda da aynı üç soru: değişti mi, gizli mi, metni ne.

/// Pano her değiştiğinde artan sayaç. Değişmediyse içeriği okumaya gerek yok.
pub fn clipboard_change_count() -> i64 {
    #[cfg(target_os = "macos")]
    { macos::pasteboard::change_count() }
    #[cfg(target_os = "windows")]
    { windows::clipboard_formats::change_count() }
    #[cfg(all(unix, not(target_os = "macos")))]
    { 0 }
}

/// İçerik bir parola yöneticisi tarafından "geçmişe alma" diye işaretlenmiş mi?
///
/// Metni OKUMADAN ÖNCE sorulur. Tespit çalışmıyorsa `false` döner — yani yakalamaya
/// devam ederiz. Bu bilinçli bir seçim: desteklenmeyen bir yapı, korumayı kaybeder
/// ama pano geçmişini komple bozmaz.
pub fn clipboard_is_concealed() -> bool {
    #[cfg(target_os = "macos")]
    { macos::pasteboard::is_concealed() }
    #[cfg(target_os = "windows")]
    { windows::clipboard_formats::is_concealed() }
    #[cfg(all(unix, not(target_os = "macos")))]
    { false }
}

pub fn clipboard_read_text() -> Option<String> {
    #[cfg(target_os = "macos")]
    { macos::pasteboard::read_text() }
    #[cfg(target_os = "windows")]
    { windows::clipboard_formats::read_text() }
    #[cfg(all(unix, not(target_os = "macos")))]
    { arboard::Clipboard::new().ok()?.get_text().ok() }
}

pub fn clipboard_write_text(text: &str) -> bool {
    #[cfg(target_os = "macos")]
    { macos::pasteboard::write_text(text) }
    #[cfg(target_os = "windows")]
    { windows::clipboard_formats::write_text(text) }
    #[cfg(all(unix, not(target_os = "macos")))]
    { arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_string())).is_ok() }
}

// ── Yapıştırma ───────────────────────────────────────────────────────────────

/// Odaktaki uygulamaya Cmd/Ctrl+V gönderir.
pub fn send_paste() {
    #[cfg(target_os = "macos")]
    macos::paste::send_paste();
    #[cfg(target_os = "windows")]
    windows::paste::send_paste();
}

/// Yapıştırılacak uygulamayı hatırla (macOS'ta anlamlı).
pub fn note_front_app() {
    #[cfg(target_os = "macos")]
    macos::paste::note_front_app();
    #[cfg(target_os = "windows")]
    windows::paste::note_front_app();
}

/// Yapıştırma için gereken izin var mı? macOS dışında her zaman `true`.
pub fn can_paste(prompt: bool) -> bool {
    #[cfg(target_os = "macos")]
    { macos::permissions::is_trusted_accessibility(prompt) }
    #[cfg(not(target_os = "macos"))]
    { let _ = prompt; true }
}
