//! macOS'ta başka bir uygulamaya Cmd+V göndermek.
//!
//! ## Electron'a göre kazanç: bir izin daha az
//!
//! Electron sürümü bunu `osascript` ile yapıyordu:
//!
//! ```text
//! tell application id "…" to activate
//! tell application "System Events" to keystroke "v" using command down
//! ```
//!
//! Bu YOL İKİ ayrı grant istiyor — Erişilebilirlik VE Automation (Apple Events) — ve
//! ikincisi `-1743` hatasıyla ayrıca reddedilebiliyordu. `paste-service.js`'te o hatayı
//! ayırt edip kullanıcıya anlatan bir sınıflandırıcı bile var.
//!
//! `CGEventPost` yalnız **Erişilebilirlik** ister. `NSWorkspace` ile uygulama
//! etkinleştirmek de hiçbir izin istemiyor. Yani:
//!
//! * `-1743` hata sınıfı tamamen ortadan kalkıyor
//! * `NSAppleEventsUsageDescription` Info.plist'ten çıkıyor
//! * osascript süreci başlatma maliyeti (paste başına ~50-100 ms) gidiyor

use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};

type CGEventSourceRef = *mut c_void;
type CGEventRef = *mut c_void;

const K_CG_HID_EVENT_TAP: u32 = 0;
/// `kCGEventSourceStateHIDSystemState` — gerçek bir tuş vuruşu gibi davranır.
const K_CG_EVENT_SOURCE_HID: u32 = 1;
const K_CG_EVENT_FLAG_MASK_COMMAND: u64 = 0x0010_0000;
/// kVK_ANSI_V — FİZİKSEL tuş. Yapıştırma her düzende bu konumdadır.
const KEYCODE_V: u16 = 0x09;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state: u32) -> CGEventSourceRef;
    fn CGEventCreateKeyboardEvent(
        source: CGEventSourceRef,
        virtual_key: u16,
        key_down: bool,
    ) -> CGEventRef;
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CFRelease(cf: *mut c_void);
}

/// Picker açıldığında hangi uygulama öndeydi. Yalnız KENDİ arayüzümüzden
/// (widget düğmesi / tepsi menüsü) açıldığında işe yarıyor: orada tıklama
/// CopyBoard'u öne getiriyor ve gerçek hedef, kullanıcının bir an önce içinde
/// olduğu uygulama oluyor.
static FRONT_APP: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// Hatırlanan hedefin ne kadar kullanılabilir kaldığı. Yalnız "üzerine gel → tıkla →
/// listeyi oku → seç" akışını atlatması yeterli. Çoktan unutulmuş bir uygulamayı
/// öne fırlatmayacak kadar kısa.
const FRONT_APP_TTL: Duration = Duration::from_secs(120);

/// Kendimizi asla "odağı geri ver" hedefi yapma.
fn is_self(bundle_id: &str) -> bool {
    bundle_id.to_lowercase().contains("copyboard")
}

/// Yapıştırılacak uygulamayı hatırla. Picker açılırken ve widget'ın üzerine gelindiğinde
/// çağrılıyor — o hover, henüz ön uygulama OLMADIĞIMIZ son an.
pub fn note_front_app() {
    autoreleasepool(|_| {
        let ws = NSWorkspace::sharedWorkspace();
        let Some(app) = ws.frontmostApplication() else { return };
        let Some(id) = app.bundleIdentifier() else { return };
        let id = id.to_string();

        let mut slot = FRONT_APP.lock().unwrap();
        if !is_self(&id) {
            *slot = Some((id, Instant::now()));
            return;
        }
        // Ön uygulama CopyBoard'un kendisi: picker widget'tan ya da tepsiden açılmış,
        // tıklama odağı almış. Kullanıcının gerçekten içinde olduğu uygulamayı TUT —
        // burada temizlemek Cmd+V'yi kendi penceremize gönderirdi. Yalnız bayatlamış
        // bir hedef düşürülüyor.
        if slot.as_ref().is_some_and(|(_, at)| at.elapsed() > FRONT_APP_TTL) {
            *slot = None;
        }
    });
}

/// Hatırlanan uygulamayı öne getirir. Zaten öndeyse işlemsiz.
fn reactivate_target() {
    let target = {
        let slot = FRONT_APP.lock().unwrap();
        slot.as_ref()
            .filter(|(_, at)| at.elapsed() <= FRONT_APP_TTL)
            .map(|(id, _)| id.clone())
    };
    let Some(bundle_id) = target else { return };

    autoreleasepool(|_| {
        use objc2_foundation::NSString;
        let ns_id = NSString::from_str(&bundle_id);
        let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&ns_id);
        if let Some(app) = running.iter().next() {
            app.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions::empty());
        }
    });
}

/// Cmd+V gönderir. Erişilebilirlik izni yoksa sessizce hiçbir şey olmaz —
/// çağıran taraf [`crate::platform::macos::permissions::is_trusted_accessibility`]
/// ile önceden kontrol ediyor.
pub fn send_paste() {
    reactivate_target();
    // Etkinleştirmenin oturması için kısa bir an. Electron sürümündeki
    // `delay 0.06` ile aynı gerekçe.
    std::thread::sleep(Duration::from_millis(60));

    unsafe {
        let source = CGEventSourceCreate(K_CG_EVENT_SOURCE_HID);

        let down = CGEventCreateKeyboardEvent(source, KEYCODE_V, true);
        CGEventSetFlags(down, K_CG_EVENT_FLAG_MASK_COMMAND);
        CGEventPost(K_CG_HID_EVENT_TAP, down);

        let up = CGEventCreateKeyboardEvent(source, KEYCODE_V, false);
        CGEventSetFlags(up, K_CG_EVENT_FLAG_MASK_COMMAND);
        CGEventPost(K_CG_HID_EVENT_TAP, up);

        if !down.is_null() { CFRelease(down); }
        if !up.is_null() { CFRelease(up); }
        if !source.is_null() { CFRelease(source); }
    }
}
