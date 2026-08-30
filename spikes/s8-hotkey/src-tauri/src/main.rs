// S8 spike — Electron'un accelerator sözlüğünün adlandıramadığı fiziksel tuşlar
// (en görünürü kVK_ISO_Section: ISO klavyelerde Esc'in altındaki, Türkçe-Q'da " basan tuş)
// Rust'tan Carbon RegisterEventHotKey ile yakalanabiliyor mu — VE tauri-plugin-global-shortcut
// ile aynı süreçte yan yana yaşayabiliyor mu?
//
// Elektron tarafındaki native/mac-hotkey/src/mac_hotkey.mm'in iki kuralı burada da geçerli:
//   1. Kayıt EVENT DISPATCHER target'ına yapılır, application target'ına DEĞİL.
//      Chromium'un kendi globalShortcut handler'ı application target'ında oturur ve
//      aldığı her hot key olayının kendi haritasında olduğunu VARSAYAR — bizim
//      olayımız oraya ulaşırsa süreç SIGTRAP ile ölür. Tauri'nin global-hotkey
//      crate'i de aynı mekanizmayı kullanıyor; bu spike o çakışmayı ölçüyor.
//   2. Handler'dan JS'e/V8'e dokunulmaz: id bir kanala itilir, callback normal
//      event loop'tan çalışır.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{atomic::{AtomicU32, Ordering}, mpsc, Mutex, OnceLock};
use tauri::Emitter;

// ── Carbon FFI ───────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod carbon {
    use std::os::raw::{c_int, c_uint, c_void};

    pub type OSStatus = i32;
    pub type OSType = u32;
    pub const NO_ERR: OSStatus = 0;
    pub const EVENT_NOT_HANDLED_ERR: OSStatus = -9874;

    pub const K_EVENT_CLASS_KEYBOARD: OSType = 0x6b657962; // 'keyb'
    pub const K_EVENT_HOT_KEY_PRESSED: c_uint = 5;
    pub const K_EVENT_PARAM_DIRECT_OBJECT: OSType = 0x2d2d2d2d; // '----'
    pub const TYPE_EVENT_HOT_KEY_ID: OSType = 0x686b6964; // 'hkid'

    // Carbon modifier bit'leri
    pub const CMD_KEY: c_uint = 1 << 8;
    pub const SHIFT_KEY: c_uint = 1 << 9;
    pub const OPTION_KEY: c_uint = 1 << 11;
    pub const CONTROL_KEY: c_uint = 1 << 12;

    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct EventTypeSpec {
        pub event_class: OSType,
        pub event_kind: c_uint,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    pub struct EventHotKeyID {
        pub signature: OSType,
        pub id: c_uint,
    }

    pub type EventRef = *mut c_void;
    pub type EventHandlerCallRef = *mut c_void;
    pub type EventHandlerRef = *mut c_void;
    pub type EventHotKeyRef = *mut c_void;
    pub type EventTargetRef = *mut c_void;
    pub type EventHandlerUPP = extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus;

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
        // Spike'ta çağrılmıyor (süreç bitince OS zaten temizler), ama üretimde
        // ŞART: kullanıcı Ayarlar'dan kısayolu değiştirdiğinde eskisi bırakılmalı.
        #[allow(dead_code)]
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

const SIGNATURE: u32 = 0x63706264; // 'cpbd' — CopyBoard

static FIRED: OnceLock<Mutex<mpsc::Sender<u32>>> = OnceLock::new();
static CARBON_HITS: AtomicU32 = AtomicU32::new(0);
static FOREIGN_PASSTHROUGH: AtomicU32 = AtomicU32::new(0);

// Kural 2: burada V8/JS yok, yalnız kanala it.
#[cfg(target_os = "macos")]
extern "C" fn hot_key_handler(
    _call: carbon::EventHandlerCallRef,
    event: carbon::EventRef,
    _user: *mut std::ffi::c_void,
) -> carbon::OSStatus {
    let mut pressed = carbon::EventHotKeyID::default();
    let ok = unsafe {
        carbon::GetEventParameter(
            event,
            carbon::K_EVENT_PARAM_DIRECT_OBJECT,
            carbon::TYPE_EVENT_HOT_KEY_ID,
            std::ptr::null_mut(),
            std::mem::size_of::<carbon::EventHotKeyID>(),
            std::ptr::null_mut(),
            &mut pressed as *mut _ as *mut std::ffi::c_void,
        )
    };
    if ok != carbon::NO_ERR {
        return carbon::EVENT_NOT_HANDLED_ERR;
    }
    // Kural 1'in ikinci yarısı: bizim olmayan hot key MUTLAKA geçirilir, yoksa
    // Tauri'nin global-shortcut'ıyla kaydedilmiş kısayollar sessizce yutulur.
    if pressed.signature != SIGNATURE {
        FOREIGN_PASSTHROUGH.fetch_add(1, Ordering::Relaxed);
        return carbon::EVENT_NOT_HANDLED_ERR;
    }
    CARBON_HITS.fetch_add(1, Ordering::Relaxed);
    if let Some(tx) = FIRED.get() {
        let _ = tx.lock().unwrap().send(pressed.id);
    }
    carbon::NO_ERR
}

#[cfg(target_os = "macos")]
fn install_carbon(app: tauri::AppHandle) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<u32>();
    FIRED.set(Mutex::new(tx)).ok();

    std::thread::spawn(move || {
        while let Ok(id) = rx.recv() {
            let label = match id {
                1 => "Cmd + \" (ISO Section)",
                2 => "Cmd + ¥ (JIS Yen)",
                3 => "Cmd + _ (JIS Underscore)",
                4 => "Cmd + Option + K (kontrol grubu)",
                _ => "?",
            };
            let _ = app.emit("hotkey", serde_json::json!({ "source": "carbon", "id": id, "label": label }));
            println!("[carbon] hot key id={id} tetiklendi");
        }
    });

    let spec = carbon::EventTypeSpec {
        event_class: carbon::K_EVENT_CLASS_KEYBOARD,
        event_kind: carbon::K_EVENT_HOT_KEY_PRESSED,
    };
    let mut handler: carbon::EventHandlerRef = std::ptr::null_mut();
    let status = unsafe {
        carbon::InstallEventHandler(
            carbon::GetEventDispatcherTarget(), // ← Kural 1
            hot_key_handler,
            1,
            &spec,
            std::ptr::null_mut(),
            &mut handler,
        )
    };
    if status != carbon::NO_ERR {
        return Err(format!("InstallEventHandler başarısız: {status}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn register_carbon(id: u32, key_code: u32, cmd: bool, shift: bool, alt: bool, ctrl: bool) -> Result<(), String> {
    let mut mods = 0u32;
    if cmd { mods |= carbon::CMD_KEY; }
    if shift { mods |= carbon::SHIFT_KEY; }
    if alt { mods |= carbon::OPTION_KEY; }
    if ctrl { mods |= carbon::CONTROL_KEY; }

    let hk_id = carbon::EventHotKeyID { signature: SIGNATURE, id };
    let mut r: carbon::EventHotKeyRef = std::ptr::null_mut();
    let status = unsafe {
        carbon::RegisterEventHotKey(key_code, mods, hk_id, carbon::GetEventDispatcherTarget(), 0, &mut r)
    };
    if status != carbon::NO_ERR || r.is_null() {
        return Err(format!("RegisterEventHotKey status={status}"));
    }
    // EventHotKeyRef ham bir pointer (Copy) — düşürmek hiçbir şey yapmaz, kayıt
    // Carbon'un kendi global tablosunda yaşar ve yalnız UnregisterEventHotKey ile
    // kalkar. Üretimde bu ref'ler accelerator → ref haritasında SAKLANACAK, çünkü
    // kısayol değiştirildiğinde eskisini bırakmanın tek yolu o.
    let _ = r;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let h = app.handle().clone();
            let mut report = serde_json::Map::new();

            // 1) Carbon: kVK_ISO_Section (0x0A) — Türkçe-Q'da " tuşu. Electron bunu ADLANDIRAMAZ.
            #[cfg(target_os = "macos")]
            {
                match install_carbon(h.clone()) {
                    Ok(_) => {
                        report.insert("carbon_handler_installed".into(), true.into());
                        // (id, keycode, cmd, shift, alt, ctrl, etiket)
                        // Son satır KONTROL GRUBU: kVK_ANSI_K her klavyede var. Carbon
                        // mekanizmasının çalıştığını, ISO tuşunun fiziksel varlığından
                        // BAĞIMSIZ olarak kanıtlar. ISO tuşu tetiklenmezse ve bu
                        // tetiklenirse, sorun mekanizma değil klavye düzenidir.
                        let combos: [(u32, u32, bool, bool, bool, bool, &str); 4] = [
                            (1, 0x0A, true, false, false, false, "Cmd + \" (kVK_ISO_Section — yalnız ISO klavye)"),
                            (2, 0x5D, true, false, false, false, "Cmd + ¥ (kVK_JIS_Yen — yalnız JIS klavye)"),
                            (3, 0x5E, true, false, false, false, "Cmd + _ (kVK_JIS_Underscore — yalnız JIS)"),
                            (4, 0x28, true, false, true,  false, "Cmd + Option + K  ← KONTROL GRUBU, her klavyede"),
                        ];
                        let mut regs = serde_json::Map::new();
                        for (id, code, cmd, shift, alt, ctrl, label) in combos {
                            match register_carbon(id, code, cmd, shift, alt, ctrl) {
                                Ok(_) => { regs.insert(label.into(), serde_json::json!("✅ kayıtlı")); }
                                Err(e) => { regs.insert(label.into(), serde_json::json!(format!("❌ {e}"))); }
                            }
                        }
                        report.insert("carbon_registrations".into(), regs.into());
                    }
                    Err(e) => { report.insert("carbon_handler_installed".into(), serde_json::json!(format!("❌ {e}"))); }
                }
            }

            // 2) Tauri global-shortcut: normal accelerator — ikisi AYNI ANDA yaşayabiliyor mu?
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };
                let gs = app.global_shortcut();
                let mut regs = serde_json::Map::new();
                let combos = [
                    ("Alt+Digit9", Shortcut::new(Some(Modifiers::ALT), Code::Digit9)),
                    ("Alt+Digit8", Shortcut::new(Some(Modifiers::ALT), Code::Digit8)),
                    ("Cmd+Shift+KeyV", Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyV)),
                    // Electron'un IntlBackslash'ı: global-hotkey bunu macOS keycode'una
                    // ÇEVİREMİYOR (kaynak koddan doğrulandı) — burada da başarısız olmalı.
                    ("Cmd+IntlBackslash", Shortcut::new(Some(Modifiers::SUPER), Code::IntlBackslash)),
                ];
                let h2 = h.clone();
                for (label, sc) in combos {
                    let hh = h2.clone();
                    let lbl = label.to_string();
                    let res = gs.on_shortcut(sc, move |_a, _s, e| {
                        // ── BULGU S8-a ───────────────────────────────────────────
                        // Handler hem BASMA hem BIRAKMA olayında çağrılıyor:
                        // plugin, global_hotkey crate'inin GlobalHotKeyEvent'ini
                        // olduğu gibi iletiyor ve o olayın state alanı var.
                        // Filtrelenmezse her kısayol İKİ KEZ çalışır — CopyBoard'da
                        // Alt+9'a bir basış = iki ekran görüntüsü.
                        // Carbon yolu kEventHotKeyPressed'e kayıtlı olduğu için
                        // bu sorunu yapısal olarak yaşamıyor.
                        let state = match e.state {
                            ShortcutState::Pressed => "pressed",
                            ShortcutState::Released => "released",
                        };
                        let _ = hh.emit("hotkey", serde_json::json!({
                            "source": "tauri", "id": lbl, "label": lbl, "state": state,
                            "counted": state == "pressed"
                        }));
                        println!("[tauri] {lbl} ({state})");
                    });
                    match res {
                        Ok(_) => { regs.insert(label.into(), serde_json::json!("✅ kayıtlı")); }
                        Err(e) => { regs.insert(label.into(), serde_json::json!(format!("❌ {e}"))); }
                    }
                }
                report.insert("tauri_global_shortcut".into(), regs.into());
            }

            report.insert("coexistence".into(), serde_json::json!(
                "her iki mekanizma da kuruldu, süreç ayakta → SIGTRAP çakışması YOK"));

            let report_val = serde_json::Value::Object(report);
            println!("\n===SPIKE_RESULT_JSON===\n{}\n===END===",
                serde_json::to_string_pretty(&report_val).unwrap());

            // Kayıt raporunu pencereye de yolla (sayfa yüklendikten sonra)
            {
                let h4 = h.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    let _ = h4.emit("registrations", report_val);
                });
            }

            if std::env::args().any(|a| a == "--exit") {
                let h3 = h.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    println!("carbon_hits={} foreign_passthrough={}",
                        CARBON_HITS.load(Ordering::Relaxed), FOREIGN_PASSTHROUGH.load(Ordering::Relaxed));
                    h3.exit(0);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri çalıştırılamadı");
}
