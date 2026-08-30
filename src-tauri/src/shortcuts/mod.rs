//! Global kısayollar — `src/main/services/ipc/shortcuts.js`'in karşılığı.
//!
//! ## İki mekanizma, tek kapı
//!
//! Kısayolların neredeyse tamamı Tauri'nin `global-shortcut` eklentisine gidiyor.
//! Bir avuç fiziksel tuşun ise accelerator adı YOK — en görüneni Türkçe-Q'da `"` basan,
//! Esc'in altındaki ISO tuşu — ve bunlar `KeyboardEvent.code` olarak kaydedilip macOS'ta
//! Carbon köprüsüne gidiyor. Yönlendirme DİZE üzerinden ([`accelerator::is_native_only`]):
//! böyle bir dizeyi Tauri'ye vermek hata vermez, **sessizce başka bir fiziksel tuşa
//! bağlar** — sessiz yanlış, gürültülü hatadan beterdir.
//!
//! ## Menü açıkken askıya alma
//!
//! macOS'ta bir NSMenu MODAL bir olay izleme döngüsü çalıştırır: menü açıkken ana süreç
//! kısayol geri çağrılarını servis etmez, bu sırada basılan her tuş KUYRUĞA girer ve menü
//! kapanınca hepsi birden ateşlenir — kullanıcı hiçbir şey olmadığını görür, sonra bir
//! seri ekran görüntüsü/OCR/kayıt patlaması. Kayıtları düşürmek, o basışı gerçek bir
//! no-op yapıyor.

pub mod accelerator;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::state::{AppState, ShortcutKey};

/// Sistemin evrensel düzenleme tuşları. YALNIZ Cmd/Ctrl ile birlikte bağlandığında
/// bunlar işe yaramazdan da kötüdür: odaktaki uygulama tuş vuruşunu (Düzen ▸ Kopyala)
/// bizim işleyicimiz çalışmadan tüketir — ve OS devretseydi, CopyBoard'un kendi içi
/// dahil her yerde Kopyala/Kes/Yapıştır'ı ele geçirirdik. macOS'ta Cmd+C, kullanıcının
/// "ekran görüntüsü kısayolu" diye uzandığı klasik tuzaktır. Alt ya da Shift eklemek
/// onu yeniden gayet iyi bir accelerator yapar — `Alt+…` varsayılanları da bu yüzden.
const RESERVED_KEYS: [&str; 5] = ["C", "V", "X", "A", "Z"];

/// Canlı kayıtlar: accelerator → hangi eylem. Menü açıkken düşürülüp geri alınabilmesi
/// için tutuluyor.
static LIVE: Mutex<Option<HashMap<String, ShortcutKey>>> = Mutex::new(None);
static SUSPENDED: AtomicBool = AtomicBool::new(false);

fn live() -> std::sync::MutexGuard<'static, Option<HashMap<String, ShortcutKey>>> {
    let mut g = LIVE.lock().unwrap();
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

/// Bir kısayol tetiklendiğinde çalışacak eylem.
fn dispatch(app: &tauri::AppHandle, key: ShortcutKey) {
    match key {
        ShortcutKey::List => crate::windows::main_window::show(app),
        ShortcutKey::Draw => crate::capture::start(app, "draw"),
        ShortcutKey::Ocr => crate::capture::start(app, "ocr"),
        ShortcutKey::Color => crate::capture::start(app, "color"),
        ShortcutKey::Scroll => crate::capture::start(app, "scroll"),
        ShortcutKey::Video => crate::capture::start(app, "video"),
        ShortcutKey::Paste => crate::windows::quickpaste::toggle(app),
    }
}

/// Bir accelerator'ı OS'tan talep eder. Native-only tuşlar Carbon'a, kalanı Tauri'ye.
fn claim(app: &tauri::AppHandle, accel: &str, key: ShortcutKey) -> bool {
    if accelerator::is_native_only(accel) {
        return claim_native(app, accel);
    }
    let Some(shortcut) = accelerator::to_shortcut(accel) else {
        log::warn!("'{accel}' çözümlenemedi — kaydedilmedi");
        return false;
    };
    let handle = app.clone();
    let result = app.global_shortcut().on_shortcut(shortcut, move |_a, _s, event| {
        // ── BULGU S8-a ───────────────────────────────────────────────────────
        // Eklenti, `global_hotkey`'in olayını olduğu gibi iletiyor ve o olay hem
        // BASMA hem BIRAKMA için geliyor. Filtrelenmezse her kısayol İKİ KEZ
        // çalışır: Alt+9'a bir basış = iki ekran görüntüsü, Cmd+Shift+V = picker'ı
        // aç ve hemen kapat. Electron'un globalShortcut'ı yalnız basmada
        // tetiklediği için mevcut kodda böyle bir filtre yoktu.
        if event.state != ShortcutState::Pressed {
            return;
        }
        dispatch(&handle, key);
    });
    match result {
        Ok(_) => true,
        Err(e) => {
            log::warn!("'{accel}' kaydedilemedi: {e}");
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn claim_native(app: &tauri::AppHandle, accel: &str) -> bool {
    use crate::platform::macos::hotkey_carbon;

    // Carbon işleyicisi tek seferlik kurulur; id → accelerator → eylem yönlendirmesi
    // burada. Geri çağrı NORMAL bir thread'den geliyor (Carbon işleyicisinden değil).
    let handle = app.clone();
    hotkey_carbon::start(move |id| {
        let Some(accel) = hotkey_carbon::accelerator_for_id(id) else { return };
        let key = live().as_ref().and_then(|m| m.get(&accel).copied());
        if let Some(key) = key {
            let h = handle.clone();
            // Ana thread'e devret: eylemler pencere açıyor.
            let _ = handle.run_on_main_thread(move || dispatch(&h, key));
        }
    });

    let Some(p) = accelerator::parse(accel) else { return false };
    let Some(code) = accelerator::native_keycode(p.key) else { return false };
    hotkey_carbon::register(
        accel,
        code,
        p.cmd_or_ctrl || p.meta,
        p.shift,
        p.alt,
        p.ctrl,
    )
    .is_some()
}

#[cfg(not(target_os = "macos"))]
fn claim_native(_app: &tauri::AppHandle, accel: &str) -> bool {
    log::warn!("'{accel}' yalnız macOS'ta kullanılabilir");
    false
}

fn release(app: &tauri::AppHandle, accel: &str) {
    if accelerator::is_native_only(accel) {
        #[cfg(target_os = "macos")]
        crate::platform::macos::hotkey_carbon::unregister(accel);
        return;
    }
    if let Some(shortcut) = accelerator::to_shortcut(accel) {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

/// Yalnız Cmd/Ctrl + bir düzenleme tuşu mu? (Cmd+C, Ctrl+V, …) Bkz. [`RESERVED_KEYS`].
pub fn is_reserved(accel: &str) -> bool {
    let Some(p) = accelerator::parse(accel) else { return false };
    p.has_cmd_ctrl() && !p.alt && !p.shift && RESERVED_KEYS.contains(&p.key.to_uppercase().as_str())
}

/// Electron yalnız ASCII accelerator anlıyordu; kaydedici de zaten `e.code` okuduğu
/// için ASCII dışı üretemiyor. Kontrol, bu bir gün değişirse kötü bir bağlamanın
/// ana sürece ulaşmasını engelliyor.
pub fn is_ascii(accel: &str) -> bool {
    !accel.is_empty() && accel.is_ascii()
}

// ── Askıya alma / geri alma ──────────────────────────────────────────────────

pub fn suspend(app: &tauri::AppHandle) {
    if SUSPENDED.swap(true, Ordering::AcqRel) {
        return;
    }
    let accels: Vec<String> = live().as_ref().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    for accel in accels {
        release(app, &accel);
    }
}

pub fn resume(app: &tauri::AppHandle) {
    if !SUSPENDED.swap(false, Ordering::AcqRel) {
        return;
    }
    let entries: Vec<(String, ShortcutKey)> = live()
        .as_ref()
        .map(|m| m.iter().map(|(a, k)| (a.clone(), *k)).collect())
        .unwrap_or_default();
    for (accel, key) in entries {
        claim(app, &accel, key);
    }
}

// ── Açılış kaydı ─────────────────────────────────────────────────────────────

/// Kalıcı bir bağlama, rezerve tuş koruması var olmadan önce kaydedilmiş olabilir
/// (ör. macOS'ta ekran görüntüsü için Cmd+C ayarlamış bir kullanıcı). Böyle bir
/// accelerator global olarak ASLA kaydolamaz. Varsayılana döndürülüyor ki hem bağlama
/// hem de Ayarlar ekranı bir sonraki açılışta kendine gelsin.
///
/// Dönen değer: sıfırlanan ilk accelerator (kullanıcıya söylemek için).
fn sanitize_persisted(state: &AppState) -> Option<String> {
    let settings = state.settings();
    let mut first_reset = None;
    for key in ShortcutKey::ALL {
        let current = settings.shortcut(key);
        if is_reserved(&current) {
            log::warn!(
                "kalıcı '{current}' ({}) sistemin düzenleme tuşlarıyla çakışıyor — \
                 varsayılana ('{}') döndürülüyor",
                key.as_str(),
                key.default()
            );
            if first_reset.is_none() {
                first_reset = Some(current);
            }
            settings.set_shortcut(key, key.default());
        }
    }
    first_reset
}

/// Açılışta tüm kısayolları kaydeder. Kapatılmış olanlar YALNIZ saklanır, kaydedilmez.
pub fn register_all(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let reset_from = sanitize_persisted(&state);
    let settings = state.settings();

    let mut paste_ok = true;
    let mut registered: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for key in ShortcutKey::ALL {
        if !settings.shortcut_enabled(key) {
            continue;
        }
        let accel = settings.shortcut(key);
        if accel.is_empty() {
            continue;
        }
        if is_reserved(&accel) {
            continue; // sanitize zaten sıfırlamış olmalı; bu son savunma
        }
        let ok = claim(app, &accel, key);
        if ok {
            live().as_mut().unwrap().insert(accel.clone(), key);
            registered.push(format!("{}={}", key.as_str(), accel));
        } else {
            failed.push(format!("{}={}", key.as_str(), accel));
            log::warn!("'{accel}' ({}) kaydedilemedi — başka bir uygulama almış olabilir", key.as_str());
        }
        if key == ShortcutKey::Paste {
            paste_ok = ok;
        }
    }

    log::info!(
        "kısayollar: {} kayıtlı [{}]{}",
        registered.len(),
        registered.join(", "),
        if failed.is_empty() { String::new() } else { format!(" · BAŞARISIZ: [{}]", failed.join(", ")) }
    );

    // Gecikmeli, tek seferlik açılış geri bildirimi. Bu olmadan, kapılmış bir Hızlı
    // Yapıştır kısayolu "bazı bilgisayarlarda açılmıyor" gizemine dönüşüyor.
    let handle = app.clone();
    let paste_accel = settings.shortcut(ShortcutKey::Paste);
    let paste_enabled = settings.shortcut_enabled(ShortcutKey::Paste);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let h = handle.clone();
        let msg = if paste_enabled && !paste_ok {
            Some((
                format!(
                    "Hızlı Yapıştır kısayolu ({}) kaydedilemedi — başka bir uygulama kullanıyor olabilir. \
                     Tepsi menüsünden açabilir veya Ayarlar'dan değiştirebilirsiniz.",
                    accelerator::to_display(&paste_accel)
                ),
                "warning",
            ))
        } else {
            reset_from.map(|from| {
                (
                    format!(
                        "\"{}\" kısayolu sistemin Kopyala/Yapıştır tuşlarıyla çakıştığı için varsayılana \
                         döndürüldü. Ayarlar'dan Alt veya Shift içeren bir kısayol seçebilirsiniz.",
                        accelerator::to_display(&from)
                    ),
                    "warning",
                )
            })
        };
        if let Some((text, kind)) = msg {
            let _ = handle.run_on_main_thread(move || crate::windows::toast::show(&h, &text, kind));
        }
    });
}

// ── Değişiklik ───────────────────────────────────────────────────────────────

/// Ayarlar ekranından gelen yeni bağlama.
pub fn update(app: &tauri::AppHandle, key: ShortcutKey, accel: &str) {
    let state = app.state::<AppState>();
    let settings = state.settings();

    if !is_ascii(accel) {
        crate::windows::toast::show(app, "Geçersiz Kısayol - Sadece ASCII karakterler kullanın", "error");
        return;
    }
    if is_reserved(accel) {
        let p = accelerator::parse(accel);
        let hint = p.map(|p| accelerator::to_display(&format!("Alt+{}", p.key))).unwrap_or_default();
        crate::windows::toast::show(
            app,
            &format!(
                "\"{}\" sistemin Kopyala/Kes/Yapıştır tuşlarıyla çakışıyor ve genel kısayol olarak \
                 çalışmaz. Alt veya Shift ekleyin (ör. {hint}).",
                accelerator::to_display(accel)
            ),
            "error",
        );
        return;
    }

    let previous = settings.shortcut(key);
    release(app, &previous);
    live().as_mut().unwrap().remove(&previous);

    // Kapatılmış bir kısayol yalnız saklanır, kaydedilmez.
    if !settings.shortcut_enabled(key) {
        settings.set_shortcut(key, accel);
        crate::tray::rebuild(app);
        return;
    }

    if claim(app, accel, key) {
        settings.set_shortcut(key, accel);
        live().as_mut().unwrap().insert(accel.to_string(), key);
        crate::tray::rebuild(app);
    } else {
        let message = if accelerator::is_native_only(accel) && !cfg!(target_os = "macos") {
            "Bu tuş bu sürümde kısayol olarak kullanılamıyor.".to_string()
        } else {
            "Kısayol kaydedilemedi - başka bir uygulama kullanıyor olabilir".to_string()
        };
        crate::windows::toast::show(app, &message, "error");
        // Çalışan eski bağlamayı geri al.
        if !previous.is_empty() && claim(app, &previous, key) {
            live().as_mut().unwrap().insert(previous, key);
        }
    }
}

/// Kısayolu aç/kapa. Kapatmak accelerator'ı diğer uygulamalara serbest bırakır ama
/// BAĞLAMAYI KAYBETMEZ; yeniden açmak aynı tuşu geri getirir.
pub fn set_enabled(app: &tauri::AppHandle, key: ShortcutKey, enabled: bool) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let accel = settings.shortcut(key);
    settings.set_shortcut_enabled(key, enabled);

    if accel.is_empty() {
        return;
    }
    if enabled {
        if claim(app, &accel, key) {
            live().as_mut().unwrap().insert(accel, key);
        } else {
            settings.set_shortcut_enabled(key, false);
            crate::windows::toast::show(
                app,
                &format!(
                    "\"{}\" kaydedilemedi — başka bir uygulama kullanıyor olabilir.",
                    accelerator::to_display(&accel)
                ),
                "error",
            );
        }
    } else {
        release(app, &accel);
        live().as_mut().unwrap().remove(&accel); // askıya alma bunu diriltmesin
    }
    crate::tray::rebuild(app);
}

/// Native-only bağlamaların menüde gösterilecek bir accelerator dizesi yok.
/// Tepsi, o öğeleri tuş ipucu OLMADAN gösteriyor — hiç göstermemek yerine.
pub fn menu_accelerator(accel: &str) -> Option<String> {
    if accel.is_empty() || accelerator::is_native_only(accel) {
        None
    } else {
        Some(accel.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rezerve_tuslar_yakalaniyor() {
        // macOS'ta Cmd+C klasik tuzak: kaydolur gibi görünür, asla çalışmaz.
        for k in ["C", "V", "X", "A", "Z"] {
            assert!(is_reserved(&format!("CommandOrControl+{k}")), "Cmd+{k} yakalanmadı");
            assert!(is_reserved(&format!("Ctrl+{k}")), "Ctrl+{k} yakalanmadı");
        }
    }

    #[test]
    fn alt_veya_shift_eklemek_rezerveligi_kaldiriyor() {
        assert!(!is_reserved("CommandOrControl+Alt+C"));
        assert!(!is_reserved("CommandOrControl+Shift+V"));
        assert!(!is_reserved("Alt+V"));
        // Varsayılan yapıştır kısayolu rezerve OLMAMALI
        assert!(!is_reserved(ShortcutKey::Paste.default()));
    }

    #[test]
    fn rezerve_olmayan_tuslar_serbest() {
        assert!(!is_reserved("CommandOrControl+B"));
        assert!(!is_reserved("Alt+9"));
        assert!(!is_reserved("F5"));
    }

    #[test]
    fn ascii_kontrolu() {
        assert!(is_ascii("Alt+9"));
        assert!(!is_ascii("Alt+Ş"));
        assert!(!is_ascii(""));
    }

    #[test]
    fn native_only_menude_accelerator_gostermiyor() {
        // Menü, adı olmayan bir tuşu göstermeye kalkarsa Electron'da patlıyordu.
        assert_eq!(menu_accelerator("CommandOrControl+IntlBackslash"), None);
        assert_eq!(menu_accelerator("Alt+9"), Some("Alt+9".into()));
        assert_eq!(menu_accelerator(""), None);
    }
}
