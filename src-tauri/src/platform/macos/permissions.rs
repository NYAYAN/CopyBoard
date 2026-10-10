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
use std::time::Duration;

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

/// Mikrofon izninin durumu (`AVAuthorizationStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicrophoneAccess {
    /// Kullanıcıya henüz sorulmadı.
    NotDetermined,
    /// Yönetim profili ya da ebeveyn denetimi engelliyor; kullanıcı da açamaz.
    Restricted,
    Denied,
    Authorized,
}

/// Mikrofon izni ne durumda? İSTEMEZ, yalnız sorar.
pub fn microphone_access() -> MicrophoneAccess {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return MicrophoneAccess::NotDetermined;
    };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => MicrophoneAccess::Authorized,
        AVAuthorizationStatus::Denied => MicrophoneAccess::Denied,
        AVAuthorizationStatus::Restricted => MicrophoneAccess::Restricted,
        _ => MicrophoneAccess::NotDetermined,
    }
}

/// Mikrofon izni var mı? Henüz sorulmadıysa sistem istemini açar ve cevabı en çok
/// `timeout` kadar bekler; süre dolarsa `false`.
///
/// İstem açıkken çağıran BLOKLANIR — ana thread'den çağırma.
///
/// Hardened runtime'lı pakette imza `com.apple.security.device.audio-input`
/// taşımıyorsa macOS istemi hiç göstermiyor ve bu anında `false` dönüyor
/// (bkz. `Entitlements.plist`).
pub fn request_microphone(timeout: Duration) -> bool {
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};

    match microphone_access() {
        MicrophoneAccess::Authorized => return true,
        MicrophoneAccess::Denied | MicrophoneAccess::Restricted => return false,
        MicrophoneAccess::NotDetermined => {}
    }
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return false };

    // Cevap rastgele bir kuyrukta geliyor. Süre dolduktan sonra gelirse alıcı
    // gitmiş olur ve gönderim sessizce düşer.
    let (tx, rx) = std::sync::mpsc::channel();
    let handler = block2::RcBlock::new(move |granted: Bool| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
    rx.recv_timeout(timeout).unwrap_or(false)
}

/// Bu sürecin imzası `name` yetkisini (`true` olarak) taşıyor mu?
///
/// Çekirdeğin gördüğü imzaya bakar — tccd'nin karar verirken baktığı da bu.
/// Yalnız `--qa` kullanıyor.
#[cfg(debug_assertions)]
pub fn has_entitlement(name: &str) -> bool {
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecTaskCreateFromSelf(allocator: *const c_void) -> *mut c_void;
        fn SecTaskCopyValueForEntitlement(
            task: *mut c_void,
            entitlement: *const c_void,
            error: *mut *mut c_void,
        ) -> *mut c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        // Crate'teki öteki bildirimlerle AYNI imza; farklısı derleyici uyarısı.
        fn CFRelease(cf: *mut c_void);
    }

    // NSString ile CFString aynı nesne (toll-free bridging).
    let key = objc2_foundation::NSString::from_str(name);
    unsafe {
        let task = SecTaskCreateFromSelf(std::ptr::null());
        if task.is_null() {
            return false;
        }
        let value = SecTaskCopyValueForEntitlement(
            task,
            objc2::rc::Retained::as_ptr(&key).cast(),
            std::ptr::null_mut(),
        );
        CFRelease(task);
        if value.is_null() {
            return false;
        }
        let on = value.cast_const() == kCFBooleanTrue;
        CFRelease(value);
        on
    }
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
