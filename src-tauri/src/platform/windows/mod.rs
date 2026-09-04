//! Windows'a özgü davranışlar: pano formatları, SendInput, güç bildirimleri, OS teması
//! ve odak çalmayan gösterim.

#![allow(dead_code)]

pub mod clipboard_formats;
pub mod paste;
pub mod power;
pub mod theme;

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
};

/// Ortak kabuk iletişim kutularının (Aç/Kaydet) pencere sınıfı.
const DIALOG_CLASS: &str = "#32770";

struct Scan {
    pid: u32,
    dialog: isize,
    titles: Vec<String>,
}

unsafe extern "system" fn scan_windows(h: HWND, l: LPARAM) -> BOOL {
    let scan = unsafe { &mut *(l.0 as *mut Scan) };
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    if pid != scan.pid || !unsafe { IsWindowVisible(h) }.as_bool() {
        return BOOL(1);
    }
    let mut cls = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut cls) };
    let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
    let mut ttl = [0u16; 128];
    let m = unsafe { GetWindowTextW(h, &mut ttl) };
    scan.titles.push(format!("{class}/{}", String::from_utf16_lossy(&ttl[..m.max(0) as usize])));
    if class == DIALOG_CLASS && scan.dialog == 0 {
        scan.dialog = h.0 as isize;
    }
    BOOL(1)
}

fn scan() -> Scan {
    let mut s = Scan { pid: std::process::id(), dialog: 0, titles: Vec::new() };
    // SAFETY: geri çağrı yalnız `s`yi yazıyor ve `EnumWindows` dönene dek yaşıyor.
    unsafe {
        let _ = EnumWindows(Some(scan_windows), LPARAM(&mut s as *mut _ as isize));
    }
    s
}

/// Bu sürece ait, GÖRÜNÜR bir kabuk iletişim kutusu (Kaydet/Aç) var mı — varsa HWND'i.
///
/// Kaydetme paneli bekçisi bunu soruyor: panel gerçekten açıksa (kullanıcı klasör
/// seçiyor olabilir) bekçi susmalı, yoksa panel açılamamış demektir.
pub fn find_open_file_dialog() -> Option<isize> {
    let s = scan();
    (s.dialog != 0).then_some(s.dialog)
}

/// Bu sürecin görünür pencereleri, `sınıf/başlık` olarak — panel bulunamadığında
/// günlüğe/QA çıktısına ne olduğunu yazmak için.
pub fn visible_window_titles() -> Vec<String> {
    scan().titles
}

/// Tauri'nin `hwnd()`u KENDİ `windows` sürümünün (0.61) `HWND`ini veriyor; bu crate
/// 0.62 kullanıyor ve iki tip farklı. İkisi de aynı ham işaretçiyi sarıyor, o yüzden
/// işaretçi üzerinden çevriliyor.
fn hwnd_of(window: &tauri::WebviewWindow) -> Result<HWND, String> {
    window.hwnd().map(|h| HWND(h.0)).map_err(|e| e.to_string())
}

/// Windows'ta `always_on_top` zaten `HWND_TOPMOST` veriyor; ayrı bir seviye kavramı yok.
pub fn set_topmost(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.set_always_on_top(true).map_err(|e| e.to_string())
}

/// Electron `showInactive()`: pencereyi aktive ETMEDEN göster.
///
/// ## ⚠ Neden ham `ShowWindow(SW_SHOWNOACTIVATE)` DEĞİL — ölçüldü
///
/// İlk hâli HWND'ye doğrudan `ShowWindow` çağırıyordu. tao pencere bayraklarını
/// kendi önbelleğinde tutuyor (`WindowFlags::VISIBLE`) ve HERHANGİ bir bayrak
/// değiştiğinde (`set_ignore_cursor_events` dahil) tüm bayrakları yeniden uyguluyor:
/// önbellek "görünmez" diyorsa `ShowWindow(SW_HIDE)` gönderiyor. Sonuç: widget
/// gösterildikten ~1 sn sonra hit-test ilk geçirgenlik değişimini yaptığında pencere
/// SESSİZCE KAYBOLUYORDU (2026-09-02'de Win32 `IsWindowVisible` ile doğrulandı).
///
/// Çözüm tao'nun kendi yolundan geçmek: `WS_EX_NOACTIVATE` bayrağını geçici olarak
/// aç, `show()` çağır (tao `SW_SHOW` gönderir ama NOACTIVATE varken pencere aktive
/// olmaz), sonra bayrağı geri al. tao'nun `apply_diff`i önce `ShowWindow`, sonra
/// stilleri uyguladığı için üçüncü adım da odak çalmıyor.
pub fn show_inactive(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.set_focusable(false).map_err(|e| e.to_string())?;
    let shown = window.show().map_err(|e| e.to_string());
    // Odaklanabilirliği HER durumda geri ver: widget'ın arama kutusu klavye istiyor.
    let _ = window.set_focusable(true);
    shown
}

/// Electron `moveTop()`: topmost bandın en önüne, odağa dokunmadan.
pub fn order_front(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = hwnd_of(window)?;
    // SAFETY: canlı HWND; SetWindowPos thread bağımsız.
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            // SWP_SHOWWINDOW YOK: gizli bir pencereyi öne almak onu göstermemeli.
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|e| e.to_string())
    }
}
