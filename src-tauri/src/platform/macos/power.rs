//! Uyku / ekran kilidi bildirimleri — Electron `powerMonitor` karşılığı.
//!
//! İki iş yapıyor:
//!
//! 1. **Bekleyen yazmaları diske boşalt.** Geçmiş kaydı 500 ms geciktiriliyor
//!    (`store::DEBOUNCED_KEYS`). Makine o pencerenin içinde uyursa yazma askıda kalıyor;
//!    uyanmadan kapanan bir makinede son kopyalanan içerik kayboluyor. Electron'un
//!    yorumu bunu açıkça söylüyordu: "sleep can outlive its 500ms window".
//!
//! 2. **Pano yoklamasını durdur.** Uyurken veya kilitliyken saniyede bir uyanmanın
//!    karşılığı yok; pil harcıyor.
//!
//! Tauri'de `powerMonitor` yok. macOS'ta uyku `NSWorkspace`in kendi bildirim
//! merkezinden, ekran kilidi ise `NSDistributedNotificationCenter`den geliyor —
//! ikisi ayrı merkez, bu yüzden ayrı ayrı kaydediliyor.

use block2::RcBlock;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSString};

/// Bildirim adları. Uyku/uyanma NSWorkspace'te, kilit/açılış dağıtık merkezde.
const WILL_SLEEP: &str = "NSWorkspaceWillSleepNotification";
const DID_WAKE: &str = "NSWorkspaceDidWakeNotification";
const SCREEN_LOCKED: &str = "com.apple.screenIsLocked";
const SCREEN_UNLOCKED: &str = "com.apple.screenIsUnlocked";

/// Uyku/kilit gözlemcilerini kurar. Ana thread'den çağrılmalı (AppKit kuralı).
pub fn install(app: &tauri::AppHandle) {
    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let ws_center = workspace.notificationCenter();
        let dist_center = NSDistributedNotificationCenter::defaultCenter();

        for (center_is_workspace, name, sleeping) in [
            (true, WILL_SLEEP, true),
            (true, DID_WAKE, false),
            (false, SCREEN_LOCKED, true),
            (false, SCREEN_UNLOCKED, false),
        ] {
            let handle = app.clone();
            let block = RcBlock::new(move |_: core::ptr::NonNull<NSNotification>| {
                if sleeping {
                    crate::clipboard::watcher::pause(&handle);
                } else {
                    crate::clipboard::watcher::resume(&handle);
                }
            });
            let ns_name = NSString::from_str(name);
            if center_is_workspace {
                let _ = ws_center.addObserverForName_object_queue_usingBlock(
                    Some(&ns_name),
                    None,
                    None,
                    &block,
                );
            } else {
                let _ = dist_center.addObserverForName_object_queue_usingBlock(
                    Some(&ns_name),
                    None,
                    None,
                    &block,
                );
            }
            // Gözlemci uygulama ömrü boyunca yaşamalı; token'ı bilerek düşürüyoruz.
        }
    }
    log::info!("uyku/kilit gözlemcileri kuruldu");
}
