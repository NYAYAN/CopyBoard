//! Sistem tepsisi — `src/main/services/tray-manager.js`'in karşılığı.
//!
//! ## Menüdeki accelerator'lar keşfedilebilirlik için DEĞİL
//!
//! Her eylem kendi global kısayolunu menüde accelerator olarak taşıyor. Sebebi şu:
//! macOS'ta bir NSMenu MODAL bir olay izleme döngüsü çalıştırır ve o döngüde ana süreç
//! global kısayol geri çağrılarını servis etmez. Menü açıkken basılan bir kısayol eskiden
//! hiçbir şey yapmıyor, sonra menü kapanınca (bu arada basılan her şeyle birlikte)
//! ateşleniyordu. Menünün kendi tuş eşdeğeri o döngüde menü tarafından işleniyor, yani
//! kısayol menü açıkken de anında çalışıyor. Global kayıtlar aynı pencere için askıya
//! alınıyor ([`crate::shortcuts::suspend`]) ki basış AYRICA kuyruğa girip sonradan
//! ikinci bir tetikleme olarak oynatılmasın.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::i18n::t;
use crate::state::{AppState, ShortcutKey};

pub const TRAY_ID: &str = "copyboard";

/// Menü öğesi kimlikleri — `on_menu_event` bunlarla yönlendiriyor.
mod id {
    pub const SHOW: &str = "show";
    pub const QUICK_PASTE: &str = "quickpaste";
    pub const CAPTURE_DRAW: &str = "capture-draw";
    pub const CAPTURE_OCR: &str = "capture-ocr";
    pub const CAPTURE_COLOR: &str = "capture-color";
    pub const CAPTURE_SCROLL: &str = "capture-scroll";
    pub const CAPTURE_VIDEO: &str = "capture-video";
    pub const QUIT: &str = "quit";
}

/// Kapatılmış bir kısayol kaydedilmiyor; menüde de reklamı yapılmamalı VE menü
/// açıkken menü tarafından onurlandırılmamalı. Öğenin kendisi tıklamayla çalışmaya
/// devam ediyor.
fn accel_for(app: &tauri::AppHandle, key: ShortcutKey) -> Option<String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if !settings.shortcut_enabled(key) {
        return None;
    }
    crate::shortcuts::menu_accelerator(&settings.shortcut(key))
}

/// Somut `AppHandle` (jenerik `R` değil): uygulama masaüstü-only ve tek bir runtime
/// kullanıyor. Jenerik imza, `AppState`'e erişmek için tip dönüşümü gerektiriyordu.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let store = &state.store;

    let handle = app;

    // Accelerator ayrıştırması muda'ya ait ve bizimkinden biraz farklı bir sözlüğü var.
    // Tek bir öğenin accelerator'ı çözümlenemezse öğe accelerator'SIZ kuruluyor —
    // aksi hâlde `build_menu` hata döner ve TEPSİNİN TAMAMI kaybolurdu. Menüdeki tuş
    // ipucu bir kolaylık; tepsi menüsü uygulamanın her zaman çalışan çıkış yolu.
    let item = |id: &str, label: String, accel: Option<String>| -> tauri::Result<_> {
        if let Some(a) = accel {
            match MenuItemBuilder::with_id(id, &label).accelerator(&a).build(app) {
                Ok(built) => return Ok(built),
                Err(e) => log::warn!("'{a}' menü accelerator'ı olarak çözümlenemedi ({e}) — tuş ipucu olmadan gösteriliyor"),
            }
        }
        MenuItemBuilder::with_id(id, &label).build(app)
    };

    MenuBuilder::new(app)
        .item(&item(id::SHOW, t(store, "Göster"), accel_for(&handle, ShortcutKey::List))?)
        // Global kısayolu kapılmış/engellenmişse (başka bir pano uygulaması, RDP
        // politikası, rezerve kombinasyon) picker'ı açmanın her zaman çalışan yolu.
        .item(&item(id::QUICK_PASTE, t(store, "Hızlı Yapıştır"), accel_for(&handle, ShortcutKey::Paste))?)
        .separator()
        .item(&item(id::CAPTURE_DRAW, t(store, "Ekran Görüntüsü Al"), accel_for(&handle, ShortcutKey::Draw))?)
        .item(&item(id::CAPTURE_OCR, t(store, "Metin Oku (OCR)"), accel_for(&handle, ShortcutKey::Ocr))?)
        .item(&item(id::CAPTURE_COLOR, t(store, "Renk Kodu Al"), accel_for(&handle, ShortcutKey::Color))?)
        .item(&item(id::CAPTURE_SCROLL, t(store, "Kaydırmalı Yakalama"), accel_for(&handle, ShortcutKey::Scroll))?)
        .item(&item(id::CAPTURE_VIDEO, t(store, "Video Kaydet"), accel_for(&handle, ShortcutKey::Video))?)
        .separator()
        .item(&item(id::QUIT, t(store, "Çıkış"), None)?)
        .build()
}

fn handle_menu(app: &tauri::AppHandle, id: &str) {
    match id {
        id::SHOW => crate::windows::main_window::show(app),
        id::QUIT => app.exit(0),
        id::QUICK_PASTE => crate::windows::quickpaste::toggle(app),
        id::CAPTURE_DRAW => crate::capture::start(app, "draw"),
        id::CAPTURE_OCR => crate::capture::start(app, "ocr"),
        id::CAPTURE_COLOR => crate::capture::start(app, "color"),
        id::CAPTURE_SCROLL => crate::capture::start(app, "scroll"),
        id::CAPTURE_VIDEO => crate::capture::start(app, "video"),
        other => log::warn!("bilinmeyen tepsi menü öğesi: {other}"),
    }
}

pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    // ── Template DEĞİL ───────────────────────────────────────────────────────
    // İlk denemede `icon_as_template(true)` verilmişti; menü çubuğunda DOLU BİR
    // KARE çıktı. Sebep: template modda macOS yalnız ALFA kanalını şekil olarak
    // kullanıp sistem rengiyle boyar, `trayIcon.png` ise mor/mavi degradeli, tam
    // opak bir ikon — alfası dolu bir yuvarlak kare, yani "şekil" o oluyor.
    //
    // Electron sürümü de bunu template işlemiyordu: macOS'ta template ayrımı
    // dosya adındaki `Template` sonekiyle yapılıyor ve bu dosyada o sonek yok.
    // Renkli hâliyle bırakmak, mevcut davranışla birebir aynı.
    let icon_bytes: &[u8] = if cfg!(target_os = "macos") {
        include_bytes!("../icons/trayIcon.png")
    } else {
        include_bytes!("../icons/icon.png")
    };
    let icon = tauri::image::Image::from_bytes(icon_bytes)?;

    let handle = app.clone();
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("CopyBoard")
        .menu(&menu)
        // macOS: SOL tık menüyü açarsa 'click' işleyicisi yutulur ve simge asla
        // sadece pencereyi gösteremez — üstelik o donduran modal menü en sık
        // kullanılan etkileşime düşerdi. Sol tık pencereyi aç/kapatıyor, menü sağ tıkta.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(move |_tray, event| {
            let TrayIconEvent::Click { button, button_state, .. } = event else { return };
            match (button, button_state) {
                (MouseButton::Left, MouseButtonState::Up) => {
                    crate::windows::main_window::toggle(&handle)
                }
                // ── Menü açıkken global kısayolları askıya al ──────────────────
                // macOS'ta NSMenu MODAL bir olay izleme döngüsü çalıştırır: menü
                // açıkken ana süreç kısayol geri çağrılarını servis etmez, bu sırada
                // basılan her tuş KUYRUĞA girer ve menü kapanınca hepsi birden
                // ateşlenir — kullanıcı hiçbir şey olmadığını görür, sonra bir seri
                // ekran görüntüsü/OCR/kayıt patlaması.
                //
                // Kapanma anını yakalamanın yolu, sorunun kendisini detektör olarak
                // kullanmak: menü açılırken ana thread'e bir iş bırakıyoruz. O iş,
                // modal döngü bitene kadar ÇALIŞMAZ — yani çalıştığı an menü kapanmış
                // demektir.
                //
                // ⚠ İş BAŞKA bir thread'den bırakılmalı. Bu işleyici ana thread'de
                // koşuyor ve tauri-runtime-wry'nin `run_on_main_thread`'i, çağıran
                // zaten ana thread'deyse kapanışı KUYRUĞA KOYMADAN hemen çalıştırıyor
                // (`send_user_message`). İlk hâli burada doğrudan çağırıyordu; `resume`
                // menü daha açılmadan koşuyor ve askıya alma fiilen hiç olmuyordu.
                // Ayrı thread'den gelen çağrı olay döngüsü proxy'sine düşüyor ve o
                // ancak modal döngü bitince servis ediliyor.
                (MouseButton::Right, MouseButtonState::Down) => {
                    crate::shortcuts::suspend(&handle);
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        // Menünün modal döngüsü kurulmadan proxy olayı işlenmesin.
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        let inner = h.clone();
                        let _ = h.run_on_main_thread(move || crate::shortcuts::resume(&inner));
                    });
                }
                _ => {}
            }
        });

    builder.build(app)?;
    Ok(())
}

/// Ayarlar bir kısayolu her an değiştirebilir; menü bir kez kuruluyor, bu yüzden
/// yeniden inşa edilmezse accelerator'lar (ve menü açıkken çalışan tuşlar) gerçek
/// bağlamalardan kayar. Dil değiştiğinde de gerekli.
pub fn rebuild(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    match build_menu(app) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log::warn!("tepsi menüsü güncellenemedi: {e}");
            }
        }
        Err(e) => log::warn!("tepsi menüsü kurulamadı: {e}"),
    }
}
