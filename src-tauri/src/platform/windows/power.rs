//! Uyku / ekran kapanması bildirimleri — Electron `powerMonitor` karşılığı (Windows).
//!
//! macOS tarafındaki `power.rs` ile aynı iki iş: uyurken pano yoklamasını durdur,
//! uyanınca devam et; durdururken store bekleyen yazmayı diske indiriyor
//! (`watcher::pause` → `flush`). Electron her platformda `suspend`/`lock-screen`
//! dinliyordu; portta Windows tarafı boştu — kilitli ekranda saniyede bir uyanıyor ve
//! 500 ms'lik debounce penceresindeki son kopya uykuya kaybediliyordu.
//!
//! ## Neden HWND'siz geri çağrı
//!
//! `WM_POWERBROADCAST` bir pencere prosedürü ister ve Tauri pencerelerinin wndproc'una
//! girmek subclass'lama demek. `RegisterSuspendResumeNotification` ve
//! `RegisterPowerSettingNotification` (Windows 8+) `DEVICE_NOTIFY_CALLBACK` ile doğrudan
//! bir fonksiyon çağırıyor — pencere yok, mesaj döngüsü yok.
//!
//! Ekran kilidi için doğrudan bir güç bildirimi yok (`WTSRegisterSessionNotification`
//! HWND ister). `GUID_CONSOLE_DISPLAY_STATE` (ekran kapandı/açıldı) pratikte aynı
//! anları veriyor: kilit ekranı bir süre sonra ekranı kapatıyor, uyku zaten ayrı geliyor.

use std::ffi::c_void;
use std::sync::OnceLock;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Power::{
    RegisterPowerSettingNotification, RegisterSuspendResumeNotification,
    DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING,
};
use windows::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
use windows::Win32::UI::WindowsAndMessaging::{
    DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
    PBT_POWERSETTINGCHANGE,
};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

unsafe extern "system" fn on_power_event(_ctx: *const c_void, kind: u32, setting: *const c_void) -> u32 {
    let Some(app) = APP.get() else { return 0 };
    match kind {
        PBT_APMSUSPEND => {
            log::info!("güç: uykuya giriliyor");
            crate::clipboard::watcher::pause(app);
        }
        PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => {
            log::info!("güç: uyanıldı");
            crate::clipboard::watcher::resume(app);
        }
        PBT_POWERSETTINGCHANGE if !setting.is_null() => {
            // SAFETY: Windows bu tür için `POWERBROADCAST_SETTING` işaretçisi veriyor.
            let s = &*(setting as *const POWERBROADCAST_SETTING);
            if s.PowerSetting == GUID_CONSOLE_DISPLAY_STATE && s.DataLength >= 4 {
                // Data: 0 = kapalı, 1 = açık, 2 = loş
                let state = *(s.Data.as_ptr() as *const u32);
                if state == 0 {
                    log::info!("güç: ekran kapandı");
                    crate::clipboard::watcher::pause(app);
                } else {
                    crate::clipboard::watcher::resume(app);
                }
            }
        }
        _ => {}
    }
    0
}

/// Güç bildirimlerini bağlar. Kayıt tutamaçları uygulama ömrü boyunca yaşamalı;
/// bilerek düşürülüyor (unregister edilmiyor).
pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());

    // ⚠ Yapı `'static` ömürde OLMALI. Windows, `DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS`
    // işaretçisini kopyaladığını GARANTİ ETMİYOR; yığında bırakılan bir yapı bu
    // fonksiyondan çıkarken yok olur ve ilk güç olayında çöp bir geri çağrı
    // işaretçisi okunur. Bilinçli olarak sızdırılıyor: kayıt uygulama ömrü boyunca
    // duruyor, hiç unregister edilmiyor.
    let params: &'static mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS =
        Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power_event),
            Context: std::ptr::null_mut(),
        }));
    // SAFETY: `params` sızdırıldığı için süreç ömrü boyunca geçerli; geri çağrı
    // `'static` bir fonksiyon ve içinde yalnız `OnceLock`'tan okuma yapıyor.
    unsafe {
        let recipient = HANDLE(params as *mut _ as *mut c_void);
        match RegisterSuspendResumeNotification(recipient, DEVICE_NOTIFY_CALLBACK) {
            Ok(_) => log::info!("uyku/uyanma bildirimi kuruldu"),
            Err(e) => log::warn!("uyku bildirimi kurulamadı: {e}"),
        }
        match RegisterPowerSettingNotification(recipient, &GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_CALLBACK) {
            Ok(_) => log::info!("ekran durumu bildirimi kuruldu"),
            Err(e) => log::warn!("ekran durumu bildirimi kurulamadı: {e}"),
        }
    }
}
