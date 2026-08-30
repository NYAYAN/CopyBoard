//! macOS TCC izinleri — `systemPreferences.*` çağrılarının karşılığı.
//!
//! Üç ayrı grant var ve KARIŞTIRILMAMALI:
//!
//! | İzin | Ne için | API |
//! |---|---|---|
//! | Ekran Kaydı | alıntı, OCR, renk, video, kaydırma | `CGPreflightScreenCaptureAccess` |
//! | Mikrofon | video kaydında ses | `AVCaptureDevice` |
//! | Erişilebilirlik | hızlı yapıştırmada Cmd+V | `AXIsProcessTrusted` |
//!
//! Electron sürümü hızlı yapıştırma için AYRICA Automation (Apple Events) izni
//! istiyordu, çünkü `osascript` kullanıyordu. Tauri sürümü `CGEventPost` kullanacağı
//! için o grant tamamen ortadan kalkıyor — bugünkü `-1743` hata sınıfı yok oluyor.

use std::ffi::c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    /// İzin var mı? İSTEMEZ, yalnız sorar.
    fn CGPreflightScreenCaptureAccess() -> bool;
    /// İzni ister. İlk çağrıda sistem diyaloğu çıkar; sonrakiler yalnız durum döner.
    /// Verilen izin ancak uygulama YENİDEN BAŞLATILDIĞINDA etkin olur.
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

pub fn has_screen_recording() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

pub fn request_screen_recording() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

/// Erişilebilirlik izni var mı? `prompt` verilirse macOS kendi "Sistem Ayarları'nı aç"
/// diyaloğunu gösterir — kullanıcının Erişilebilirlik panelini elle aramasını
/// engelleyen şey budur.
///
/// Bir sorgu hatası izni ENGELLEMEZ: `true` döner, yani yapıştırma denenir.
pub fn is_trusted_accessibility(prompt: bool) -> bool {
    use objc2_foundation::{NSDictionary, NSNumber, NSString};

    if !prompt {
        return unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) };
    }
    let key = NSString::from_str("AXTrustedCheckOptionPrompt");
    let value = NSNumber::new_bool(true);
    let options = NSDictionary::from_slices(&[&*key], &[&*value as &objc2::runtime::AnyObject]);
    unsafe { AXIsProcessTrustedWithOptions(objc2::rc::Retained::as_ptr(&options) as *const c_void) }
}
