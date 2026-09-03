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
/// Askıya alma nesli — 60 sn'lik güvenlik ağının eski bir askıya almayı geri
/// almasını engelliyor.
static SUSPEND_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn live() -> std::sync::MutexGuard<'static, Option<HashMap<String, ShortcutKey>>> {
    let mut g = LIVE.lock().unwrap();
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

/// Kısayol işleyicisinden çıkıp işi ana thread'e ERTELENMİŞ olarak devreder.
///
/// ## ⚠ Neden zorunlu — ölçüldü (2026-09-02, Windows `AppHangB1`)
///
/// `tauri-plugin-global-shortcut`, işleyicimizi kendi `shortcuts` Mutex'ini TUTARKEN
/// çağırıyor (`GlobalHotKeyEvent::set_event_handler` içindeki `shortcuts_.lock()`).
/// İşleyici içinde başka bir kısayol kaydetmek ya da kaldırmak (`on_shortcut`,
/// `unregister`) aynı kilidi ikinci kez almaya çalışıyor; `std::sync::Mutex` yeniden
/// girilemez, ana thread orada ölüyor. Somut yol: Ctrl+Shift+V → `quickpaste::show`
/// → Escape'i kaydet → kilit. Kullanıcıda: seçici açılıyor, sonra hiçbir şey tıklanmıyor.
///
/// Eylem bir thread üzerinden `run_on_main_thread` ile geri postalanıyor: olay
/// döngüsü proxy'sinden geldiği için ancak işleyici DÖNDÜKTEN (kilit bırakıldıktan)
/// sonra koşuyor; yine ana thread'de olduğu için macOS AppKit kuralı da korunuyor.
/// Doğrudan `run_on_main_thread` yetmez: çağıran zaten ana thread'deyse kapanış
/// hemen, kilit hâlâ tutulurken çalışır (bkz. `tray.rs`'teki aynı tuzak).
pub fn defer_to_main(app: &tauri::AppHandle, f: impl FnOnce(&tauri::AppHandle) + Send + 'static) {
    let h = app.clone();
    std::thread::spawn(move || {
        let inner = h.clone();
        let _ = h.run_on_main_thread(move || f(&inner));
    });
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
        // Eklentinin kilidi altındayız — eylemi ertele (bkz. `defer_to_main`).
        defer_to_main(&handle, move |h| dispatch(h, key));
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
    // Değiştiricisiz bir global bağlama, o fiziksel tuşu SİSTEM ÇAPINDA ele geçirir —
    // kullanıcı o tuşu hiçbir uygulamada yazamaz olur. Kaydedici zaten buna izin
    // vermiyor (`accelerator.js`), ama elle düzenlenmiş bir config.json geçebilir.
    if !(p.cmd_or_ctrl || p.meta || p.ctrl || p.alt || p.shift) {
        log::warn!("'{accel}' değiştiricisiz — çıplak tuşu sistem çapında ele geçirmemek için reddedildi");
        return false;
    }
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

    // Menünün kapanma olayı bir sebeple gelmezse uygulamayı KALICI olarak kısayolsuz
    // bırakmayalım. Electron'da da aynı emniyet vardı (`resumeWatchdog`).
    let generation = SUSPEND_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        // Bu arada normal bir resume olduysa nesil değişmiştir; karışma.
        if SUSPEND_GENERATION.load(Ordering::Acquire) != generation {
            return;
        }
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            log::warn!("kısayol askıya alma 60 sn sürdü — güvenlik ağı devrede, geri alınıyor");
            resume(&h);
        });
    });
}

pub fn resume(app: &tauri::AppHandle) {
    if !SUSPENDED.swap(false, Ordering::AcqRel) {
        return;
    }
    SUSPEND_GENERATION.fetch_add(1, Ordering::AcqRel);
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

/// Electron'un kaydettiği ama bu sürümün ÇÖZEMEDİĞİ bir bağlama (ör. `AltGr+X`, ya da
/// tamamen bozuk bir dize) kalıcı olabilir. Böyle bir accelerator hiç kaydolamaz;
/// sessizce loglayıp ayarlarda ölü bir bağlama göstermek yerine varsayılana döndürülüyor
/// ve kullanıcıya söyleniyor — rezerve tuş yoluyla aynı muamele.
///
/// Dönen değer: sıfırlanan ilk accelerator.
fn reset_unparseable(state: &AppState) -> Option<String> {
    let settings = state.settings();
    let mut first_reset = None;
    for key in ShortcutKey::ALL {
        let current = settings.shortcut(key);
        if current.is_empty() || accelerator::is_parseable(&current) {
            continue;
        }
        log::warn!(
            "kalıcı '{current}' ({}) bu sürümde çözümlenemiyor — varsayılana ('{}') döndürülüyor",
            key.as_str(),
            key.default()
        );
        if first_reset.is_none() {
            first_reset = Some(current);
        }
        settings.set_shortcut(key, key.default());
    }
    first_reset
}

/// Açılışta tüm kısayolları kaydeder. Kapatılmış olanlar YALNIZ saklanır, kaydedilmez.
pub fn register_all(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let reset_from = sanitize_persisted(&state);
    let unparseable_from = reset_unparseable(&state);
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

    // sanitize_persisted bir bağlamayı varsayılana döndürmüş olabilir; tepsi menüsü
    // aksi hâlde eski (rezerve) accelerator'ı göstermeye devam eder.
    crate::tray::rebuild(app);

    // Gecikmeli, tek seferlik açılış geri bildirimi. Bu olmadan, kapılmış bir Hızlı
    // Yapıştır kısayolu "bazı bilgisayarlarda açılmıyor" gizemine dönüşüyor.
    let handle = app.clone();
    let paste_accel = settings.shortcut(ShortcutKey::Paste);
    let paste_enabled = settings.shortcut_enabled(ShortcutKey::Paste);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let h = handle.clone();
        let store = &handle.state::<AppState>().store;
        let msg = if paste_enabled && !paste_ok {
            let shown = accelerator::to_display(&paste_accel);
            Some((
                crate::i18n::t_vars(
                    store,
                    "Hızlı Yapıştır kısayolu ({shortcut}) kaydedilemedi — başka bir uygulama kullanıyor olabilir. \
                     Tepsi menüsünden açabilir veya Ayarlar'dan değiştirebilirsiniz.",
                    &[("shortcut", shown.as_str())],
                ),
                "warning",
            ))
        } else if let Some(from) = reset_from {
            let shown = accelerator::to_display(&from);
            Some((
                crate::i18n::t_vars(
                    store,
                    "\"{shortcut}\" kısayolu sistemin Kopyala/Yapıştır tuşlarıyla çakıştığı için varsayılana \
                     döndürüldü. Ayarlar'dan Alt veya Shift içeren bir kısayol seçebilirsiniz.",
                    &[("shortcut", shown.as_str())],
                ),
                "warning",
            ))
        } else {
            unparseable_from.map(|from| {
                let shown = accelerator::to_display(&from);
                (
                    crate::i18n::t_vars(
                        store,
                        "\"{shortcut}\" kısayolu bu sürümde tanınmadığı için varsayılana döndürüldü. \
                         Ayarlar'dan yeniden seçebilirsiniz.",
                        &[("shortcut", shown.as_str())],
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

    let store = &state.store;
    if !is_ascii(accel) {
        let msg = crate::i18n::t(store, "Geçersiz Kısayol - Sadece ASCII karakterler kullanın");
        crate::windows::toast::show(app, &msg, "error");
        return;
    }
    if is_reserved(accel) {
        let p = accelerator::parse(accel);
        let hint = p.map(|p| accelerator::to_display(&format!("Alt+{}", p.key))).unwrap_or_default();
        let shown = accelerator::to_display(accel);
        let msg = crate::i18n::t_vars(
            store,
            "\"{shortcut}\" sistemin Kopyala/Kes/Yapıştır tuşlarıyla çakışıyor ve genel kısayol olarak \
             çalışmaz. Alt veya Shift ekleyin (ör. {hint}).",
            &[("shortcut", shown.as_str()), ("hint", hint.as_str())],
        );
        crate::windows::toast::show(app, &msg, "error");
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
            crate::i18n::t(store, "Bu tuş bu sürümde kısayol olarak kullanılamıyor.")
        } else {
            crate::i18n::t(store, "Kısayol kaydedilemedi - başka bir uygulama kullanıyor olabilir")
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
            let shown = accelerator::to_display(&accel);
            let msg = crate::i18n::t_vars(
                &state.store,
                "\"{shortcut}\" kaydedilemedi — başka bir uygulama kullanıyor olabilir.",
                &[("shortcut", shown.as_str())],
            );
            crate::windows::toast::show(app, &msg, "error");
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
        return None;
    }
    Some(muda_key_names(accel))
}

/// Electron'un numpad kısaltmalarını menü ayrıştırıcısının tanıdığı adlara çevirir.
///
/// Tepsi menüsü accelerator'ları `muda` ile ayrıştırıyor. muda `numadd`i (ve `num0..9`u)
/// tanıyor ama diğer dört numpad işlecinde Electron'dan AYRILIYOR: uzun adları istiyor.
/// Çevrilmezse `MenuItemBuilder::accelerator` hata veriyor, `tray::rebuild` öğeyi
/// accelerator'sız kuruyor ve kullanıcı numpad'e kısayol atadıysa tuş ipucu menüden
/// sessizce kayboluyor.
///
/// | Ayarlarda saklanan | muda'nın istediği |
/// |---|---|
/// | `numsub`  | `NumSubtract` |
/// | `nummult` | `NumMultiply` |
/// | `numdiv`  | `NumDivide`   |
/// | `numdec`  | `NumDecimal`  |
fn muda_key_names(accel: &str) -> String {
    accel
        .split('+')
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "numsub" => "NumSubtract",
            "nummult" => "NumMultiply",
            "numdiv" => "NumDivide",
            "numdec" => "NumDecimal",
            _ => part,
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kaydedicinin üretebildiği HER tuş, tepsi menüsünün gerçek ayrıştırıcısından
    /// geçmeli. Elle tutulan bir liste değil, `muda`nın kendisi doğruluyor: muda bir
    /// sürümde tuş adı değiştirirse bu test kırılır, üretimde menü sessizce
    /// accelerator'ını kaybetmez.
    #[test]
    fn menu_accelerator_ciktisi_muda_tarafindan_ayristirilabiliyor() {
        use std::str::FromStr;
        let uretilen = [
            "Space", "Tab", "Enter", "Backspace", "Delete", "Insert", "Home", "End",
            "PageUp", "PageDown", "Up", "Down", "Left", "Right",
            ",", ".", "/", "\\", ";", "'", "[", "]", "`", "-", "=",
            "numadd", "numsub", "nummult", "numdiv", "numdec",
            "A", "Z", "0", "9", "num0", "num9", "F1", "F12",
        ];
        for key in uretilen {
            let accel = format!("CommandOrControl+Shift+{key}");
            let out = menu_accelerator(&accel).expect("menüde gösterilebilmeli");
            muda::accelerator::Accelerator::from_str(&out)
                .unwrap_or_else(|e| panic!("'{accel}' -> '{out}' muda tarafından ayrıştırılamadı: {e}"));
        }
    }

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
