//! Electron'un accelerator sözlüğünün adlandıramadığı fiziksel tuşlar için global
//! kısayol — `native/mac-hotkey/src/mac_hotkey.mm`'in Rust portu.
//!
//! Node eklentisi tamamen ortadan kalkıyor: `node-gyp` yok, `postinstall` derlemesi yok,
//! kullanıcıda derleyici gerekmiyor.
//!
//! ## Neden gerekli
//!
//! `tauri-plugin-global-shortcut`, `global-hotkey` crate'i üzerinden çalışıyor ve
//! `Code::IntlBackslash`'ı **açıkça reddediyor** (Spike-8'de ölçüldü:
//! `Unable to register hotkey: Unknown scancode for IntlBackslash`). O tuş, Apple'ın ISO
//! klavyelerinde Esc'in altındaki tuştur ve Türkçe-Q düzeninde `"` basar. Carbon'un
//! `RegisterEventHotKey`'i ham sanal tuş kodu aldığı için böyle bir boşluğu yok.
//!
//! Bu bir tuş dinleyicisi DEĞİL: tam kombinasyon basılana dek hiçbir şey çalışmıyor,
//! yani kullanıcı yazarken sıfır maliyet. ("Global key listener" paketlerinin kullandığı
//! event tap, sistemdeki her tuş vuruşunu görürdü. Kasıtlı olarak o değil.)
//!
//! ## İki kural — ikisi de çökmelerden öğrenildi
//!
//! **1. Kayıt EVENT DISPATCHER hedefine yapılır, uygulama hedefine değil.** Diğer
//! mekanizmanın (Chromium/`global-hotkey`) kendi işleyicisi uygulama hedefinde oturuyor
//! ve aldığı her hot key olayının kendi haritasında olduğunu varsayıyor — bizim
//! olayımız oraya ulaşırsa süreç SIGTRAP ile ölüyor. Dispatcher hedefi ikisini ayırıyor.
//! Bunun bir yarısı da: **bizim olmayan hot key MUTLAKA `eventNotHandledErr` ile
//! geçirilir**, yoksa Tauri'nin kendi kısayolları sessizce yutulur.
//!
//! **2. Carbon işleyicisi kullanıcı koduna dokunmaz.** Bir hot key, ana thread iç içe
//! bir run loop'tayken (menü izleme, pencere sürükleme) gelebilir. İşleyici yalnız id'yi
//! bir kanala itip dönüyor; eylem normal olay döngüsünden çalışıyor.

#![allow(non_upper_case_globals)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};

mod ffi {
    use std::ffi::c_void;
    use std::os::raw::{c_int, c_uint};

    pub type OSStatus = i32;
    pub type OSType = u32;
    pub const NO_ERR: OSStatus = 0;
    pub const EVENT_NOT_HANDLED_ERR: OSStatus = -9874;

    pub const K_EVENT_CLASS_KEYBOARD: OSType = 0x6b65_7962; // 'keyb'
    pub const K_EVENT_HOT_KEY_PRESSED: c_uint = 5;
    pub const K_EVENT_PARAM_DIRECT_OBJECT: OSType = 0x2d2d_2d2d; // '----'
    pub const TYPE_EVENT_HOT_KEY_ID: OSType = 0x686b_6964; // 'hkid'

    pub const CMD_KEY: c_uint = 1 << 8;
    pub const SHIFT_KEY: c_uint = 1 << 9;
    pub const OPTION_KEY: c_uint = 1 << 11;
    pub const CONTROL_KEY: c_uint = 1 << 12;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct EventTypeSpec {
        pub event_class: OSType,
        pub event_kind: c_uint,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct EventHotKeyID {
        pub signature: OSType,
        pub id: c_uint,
    }

    pub type EventRef = *mut c_void;
    pub type EventHandlerCallRef = *mut c_void;
    pub type EventHandlerRef = *mut c_void;
    pub type EventHotKeyRef = *mut c_void;
    pub type EventTargetRef = *mut c_void;
    pub type EventHandlerUPP =
        extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus;

    extern "C" {
        pub fn GetEventDispatcherTarget() -> EventTargetRef;
        pub fn InstallEventHandler(
            target: EventTargetRef,
            handler: EventHandlerUPP,
            num_types: c_int,
            list: *const EventTypeSpec,
            user_data: *mut c_void,
            out_ref: *mut EventHandlerRef,
        ) -> OSStatus;
        pub fn RegisterEventHotKey(
            key_code: c_uint,
            modifiers: c_uint,
            hot_key_id: EventHotKeyID,
            target: EventTargetRef,
            options: c_uint,
            out_ref: *mut EventHotKeyRef,
        ) -> OSStatus;
        pub fn UnregisterEventHotKey(hot_key: EventHotKeyRef) -> OSStatus;
        pub fn GetEventParameter(
            event: EventRef,
            name: OSType,
            desired_type: OSType,
            actual_type: *mut OSType,
            buffer_size: usize,
            actual_size: *mut usize,
            data: *mut c_void,
        ) -> OSStatus;
    }
}

/// Hot key id'lerimizi ad alanına alır — 'cpbd' (CopyBoard).
const SIGNATURE: u32 = 0x6370_6264;

/// Carbon işleyicisinden tetiklenen id'leri taşıyan kanal (Kural 2).
static TX: OnceLock<Mutex<Sender<u32>>> = OnceLock::new();

struct Registration {
    id: u32,
    /// `UnregisterEventHotKey` için gereken tutamaç. Bu saklanmazsa kısayolu
    /// DEĞİŞTİRMEK imkânsız olur: eskisi sonsuza dek kayıtlı kalır.
    reference: ffi::EventHotKeyRef,
}

// SAFETY: EventHotKeyRef opak bir Carbon tutamacı. Yalnız kayıt ve kayıt silme
// için kullanılıyor, ikisi de aynı kilit altında.
unsafe impl Send for Registration {}

static REGISTRY: OnceLock<Mutex<HashMap<String, Registration>>> = OnceLock::new();
static NEXT_ID: Mutex<u32> = Mutex::new(1);
static STARTED: Mutex<bool> = Mutex::new(false);

fn registry() -> &'static Mutex<HashMap<String, Registration>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `noErr` dönmek "işlendi, yayılmayı durdur" demektir. Bu işleyici dispatcher
/// hedefinde oturduğu için süreçteki HER hot key önce buradan geçiyor — diğer
/// mekanizmanınkiler dahil. Bizim olmayan her şey `eventNotHandledErr` ile çıkmalı.
extern "C" fn hot_key_handler(
    _call: ffi::EventHandlerCallRef,
    event: ffi::EventRef,
    _user: *mut c_void,
) -> ffi::OSStatus {
    let mut pressed = ffi::EventHotKeyID::default();
    let ok = unsafe {
        ffi::GetEventParameter(
            event,
            ffi::K_EVENT_PARAM_DIRECT_OBJECT,
            ffi::TYPE_EVENT_HOT_KEY_ID,
            std::ptr::null_mut(),
            std::mem::size_of::<ffi::EventHotKeyID>(),
            std::ptr::null_mut(),
            &mut pressed as *mut _ as *mut c_void,
        )
    };
    if ok != ffi::NO_ERR || pressed.signature != SIGNATURE {
        return ffi::EVENT_NOT_HANDLED_ERR; // bizim değil — geçir
    }
    // Kural 2: yalnız kuyruğa it, burada başka hiçbir şey yapma.
    if let Some(tx) = TX.get() {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(pressed.id);
        }
    }
    ffi::NO_ERR
}

/// Uygulama çapında tek işleyiciyi kurar. `on_hotkey`, tetiklenen id ile NORMAL bir
/// thread'den çağrılır (Carbon işleyicisinden değil).
pub fn start<F>(on_hotkey: F) -> bool
where
    F: Fn(u32) + Send + 'static,
{
    let mut started = STARTED.lock().unwrap();
    if *started {
        return true;
    }

    let (tx, rx) = std::sync::mpsc::channel::<u32>();
    if TX.set(Mutex::new(tx)).is_err() {
        return false;
    }
    std::thread::Builder::new()
        .name("copyboard-carbon-hotkey".into())
        .spawn(move || {
            while let Ok(id) = rx.recv() {
                on_hotkey(id);
            }
        })
        .ok();

    let spec = ffi::EventTypeSpec {
        event_class: ffi::K_EVENT_CLASS_KEYBOARD,
        event_kind: ffi::K_EVENT_HOT_KEY_PRESSED,
    };
    let mut handler: ffi::EventHandlerRef = std::ptr::null_mut();
    let status = unsafe {
        ffi::InstallEventHandler(
            ffi::GetEventDispatcherTarget(), // ← Kural 1
            hot_key_handler,
            1,
            &spec,
            std::ptr::null_mut(),
            &mut handler,
        )
    };
    if status != ffi::NO_ERR {
        log::error!("Carbon InstallEventHandler başarısız: {status}");
        return false;
    }
    *started = true;
    true
}

/// Kısayolu kaydeder. Aynı accelerator zaten kayıtlıysa önce sökülür (yeniden bağlama).
/// Dönen id, `start()`'a verilen geri çağrıya gelen değerdir.
pub fn register(
    accelerator: &str,
    key_code: u32,
    cmd: bool,
    shift: bool,
    alt: bool,
    ctrl: bool,
) -> Option<u32> {
    unregister(accelerator);

    let id = {
        let mut n = NEXT_ID.lock().unwrap();
        let id = *n;
        *n += 1;
        id
    };

    let mut mods = 0u32;
    if cmd { mods |= ffi::CMD_KEY; }
    if shift { mods |= ffi::SHIFT_KEY; }
    if alt { mods |= ffi::OPTION_KEY; }
    if ctrl { mods |= ffi::CONTROL_KEY; }

    let hk_id = ffi::EventHotKeyID { signature: SIGNATURE, id };
    let mut reference: ffi::EventHotKeyRef = std::ptr::null_mut();
    let status = unsafe {
        ffi::RegisterEventHotKey(
            key_code,
            mods,
            hk_id,
            ffi::GetEventDispatcherTarget(),
            0,
            &mut reference,
        )
    };
    if status != ffi::NO_ERR || reference.is_null() {
        // Başka bir uygulama almış ya da OS reddetti.
        log::warn!("Carbon RegisterEventHotKey('{accelerator}') başarısız: {status}");
        return None;
    }

    registry()
        .lock()
        .unwrap()
        .insert(accelerator.to_string(), Registration { id, reference });
    Some(id)
}

pub fn unregister(accelerator: &str) -> bool {
    let Some(reg) = registry().lock().unwrap().remove(accelerator) else {
        return false;
    };
    unsafe { ffi::UnregisterEventHotKey(reg.reference) };
    true
}

pub fn unregister_all() {
    let mut map = registry().lock().unwrap();
    for (_, reg) in map.drain() {
        unsafe { ffi::UnregisterEventHotKey(reg.reference) };
    }
}

/// Bir id'nin hangi accelerator'a ait olduğunu bulur — geri çağrı yönlendirmesi için.
pub fn accelerator_for_id(id: u32) -> Option<String> {
    registry()
        .lock()
        .unwrap()
        .iter()
        .find(|(_, r)| r.id == id)
        .map(|(a, _)| a.clone())
}
