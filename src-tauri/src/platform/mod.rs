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

/// Pencerenin EKRAN YAKALAMA kimliği (macOS'ta CGWindowID). Yalnız macOS'ta
/// anlamlı; başka platformda `None` — Windows'ta overlay `WDA_EXCLUDEFROMCAPTURE`
/// ile zaten karelere hiç girmiyor.
pub fn capture_window_id(window: &tauri::WebviewWindow) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        match macos::window_id(window) {
            Ok(id) => Some(id),
            Err(e) => {
                log::warn!("{}: CGWindowID okunamadı: {e}", window.label());
                None
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        None
    }
}

/// Pencereyi diğer (aynı seviyedeki) pencerelerin ÖNÜNE getirir.
///
/// Electron her `setAlwaysOnTop(…, 'screen-saver', 1)` çağrısının ardından `moveTop()`
/// da çağırıyordu — seviyeyi ayarlamak pencereyi aynı seviyedeki diğer topmost
/// pencerelerin önüne GETİRMİYOR. Bu olmadan widget, toast ve hızlı yapıştır başka bir
/// topmost pencerenin altında kalabiliyor.
pub fn order_front(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::order_front(window)
    }
    #[cfg(target_os = "windows")]
    {
        // `set_always_on_top(true)` tao'da bayrak FARKI olarak uygulanıyor: pencere
        // zaten topmost ise hiçbir şey gönderilmiyor, yani `moveTop()` karşılığı
        // değildi. `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)` topmost bandın
        // EN ÖNÜNE taşıyor — odağa dokunmadan.
        windows::order_front(window)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        window.set_always_on_top(true).map_err(|e| e.to_string())
    }
}

/// Pencereyi ODAK ÇALMADAN gösterir — Electron `showInactive()`.
///
/// Tauri'nin `show()`u macOS'ta `makeKeyAndOrderFront`, Windows'ta aktive eden bir
/// `ShowWindow` yapıyor. Widget gibi yüzen bir araç kullanıcının yazdığı alandan odağı
/// almamalı: açılışta, ayardan açılınca ve her yakalama bitiminde odak kayboluyordu.
pub fn show_inactive(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::show_inactive(window)
    }
    #[cfg(target_os = "windows")]
    {
        windows::show_inactive(window)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        window.show().map_err(|e| e.to_string())
    }
}

/// OS görünümü koyu mu — PENCERE OLMADAN. İlk pencere kurulurken `Window::theme()`
/// soracak bir pencere yok; `theme: 'system'` ilk karede doğru renkle açılabilsin diye
/// OS'a doğrudan soruluyor. Bilinemiyorsa `None`.
pub fn os_prefers_dark_hint() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        macos::os_prefers_dark_hint()
    }
    #[cfg(target_os = "windows")]
    {
        windows::theme::os_prefers_dark()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
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

/// Uyku/ekran-kilidi bildirimlerini bağlar (Electron `powerMonitor`).
pub fn install_power_observers(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    macos::power::install(app);
    #[cfg(target_os = "windows")]
    windows::power::install(app);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = app;
}

/// Ses giriş aygıtları. macOS dışında boş — orada seçim henüz yazılmadı.
pub fn audio_inputs() -> Vec<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        macos::audio_devices::list()
            .into_iter()
            .filter_map(|d| serde_json::to_value(d).ok())
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    { Vec::new() }
}
