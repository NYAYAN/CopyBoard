//! Uygulama durumu — `src/main/services/state.js`'in karşılığı.
//!
//! İki parça var ve ayrı tutuluyorlar:
//!
//! * **Kalıcı** ayarlar [`crate::store::Store`]'da yaşar. Electron sürümü bunları
//!   `state` nesnesine kopyalıyordu; burada tek kaynak store'un kendisi, ve tipli
//!   erişimciler ([`Settings`]) varsayılanları tek yerde tutuyor.
//! * **Çalışma anı** durumu [`Runtime`]'da. Diske hiç yazılmaz.
//!
//! Pencere tutamaçları BURADA TUTULMUYOR: Electron'da `state.mainWindow` gibi alanlar
//! `isDestroyed()` kontrolleriyle birlikte geliyordu; Tauri pencereleri etiketle
//! adresliyor, `app.get_webview_window("main")` zaten yaşayan pencereyi ya da `None`
//! döndürüyor. Böylece "yok edilmiş pencereye dokunma" hatası sınıfı ortadan kalkıyor.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::store::Store;

/// Tepsiden gösterilen bir pencere, macOS odağı geri verirken mikrosaniyeler sonra
/// `blur` alabiliyor; blur işleyicisi onu yeniden gizlerse "Göster" hiçbir şey
/// yapmamış gibi görünür. Kasıtlı bir gösterimden bu kadar kısa süre sonraki
/// blur'lar yok sayılır. (Electron: `SHOW_SETTLE_MS`.)
pub const SHOW_SETTLE_MS: u128 = 600;

/// Tepsi tıklaması aç/kapa: pencere blur'da kendini gizlediği için, tıklama olayı
/// geldiğinde ÇOKTAN gizlenmiş oluyor. Az önce olmuş bir gizleme "bu tıklama onu
/// kapattı" sayılır.
pub const TOGGLE_GUARD_MS: u128 = 400;

#[derive(Default)]
pub struct Runtime {
    /// Pano izleyicisinin kendi yazdığımız değeri "yeni kopya" sanmasını engeller.
    pub last_text: String,
    /// Son yakalama kipi: `draw` | `ocr` | `color` | `video` | `scroll`.
    pub last_mode: String,
    pub is_capturing: bool,

    pub main_shown_at: Option<Instant>,
    pub main_was_focused: bool,
    pub main_hidden_at: Option<Instant>,

    pub toast_ready: bool,
    pub pending_toast: Option<(String, String)>,
}

pub struct AppState {
    pub store: Arc<Store>,
    pub runtime: Mutex<Runtime>,
}

impl AppState {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            runtime: Mutex::new(Runtime {
                last_mode: "draw".into(),
                ..Default::default()
            }),
        }
    }

    pub fn settings(&self) -> Settings<'_> {
        Settings { store: &self.store }
    }
}

/// Kalıcı ayarların tipli görünümü. Varsayılanlar TEK yerde — `state.js`'te aynı
/// sayılar hem `state` nesnesinde hem `shortcuts.js`'in `DEFAULTS`'unda tekrar
/// ediyordu ve ikisi birbirinden kayabiliyordu.
pub struct Settings<'a> {
    store: &'a Store,
}

macro_rules! setting {
    ($get:ident, $set:ident, $key:literal, $ty:ty, $default:expr) => {
        pub fn $get(&self) -> $ty {
            self.store.get($key, $default)
        }
        pub fn $set(&self, v: $ty) {
            self.store.set($key, v);
        }
    };
}

impl<'a> Settings<'a> {
    setting!(max_items, set_max_items, "maxItems", i64, 50);
    setting!(quick_paste_count, set_quick_paste_count, "quickPasteCount", i64, 20);
    setting!(auto_start, set_auto_start, "autoStart", bool, true);
    setting!(clipboard_paused, set_clipboard_paused, "clipboardPaused", bool, false);
    setting!(video_quality, set_video_quality, "videoQuality", String, "high".into());
    setting!(audio_mic, set_audio_mic, "audioMic", bool, false);
    setting!(audio_system, set_audio_system, "audioSystem", bool, false);
    setting!(show_widget, set_show_widget, "showWidget", bool, false);
    setting!(widget_transparent, set_widget_transparent, "widgetTransparent", bool, false);
    setting!(widget_color, set_widget_color, "widgetColor", String, "#8957e5".into());
    setting!(widget_opacity, set_widget_opacity, "widgetOpacity", i64, 100);
    setting!(widget_scale, set_widget_scale, "widgetScale", i64, 100);

    /// Kısayol erişimcileri ayrı: her biri farklı bir store anahtarında ve
    /// varsayılanları `shortcuts.js`'in `DEFAULTS`'uyla birebir aynı olmak zorunda.
    pub fn shortcut(&self, key: ShortcutKey) -> String {
        self.store.get(key.store_key(), key.default().to_string())
    }

    pub fn set_shortcut(&self, key: ShortcutKey, accel: &str) {
        self.store.set(key.store_key(), accel);
    }

    /// Kapatılmış bir kısayolun BAĞLAMASI KORUNUR — yalnız OS kaydı düşer, böylece
    /// yeniden açınca aynı tuş geri gelir.
    pub fn shortcut_enabled(&self, key: ShortcutKey) -> bool {
        self.store
            .get_value("shortcutsEnabled")
            .and_then(|v| v.get(key.as_str()).and_then(|b| b.as_bool()))
            .unwrap_or(true)
    }

    pub fn set_shortcut_enabled(&self, key: ShortcutKey, enabled: bool) {
        let mut map = self
            .store
            .get_value("shortcutsEnabled")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        map.insert(key.as_str().into(), serde_json::Value::Bool(enabled));
        self.store.set("shortcutsEnabled", serde_json::Value::Object(map));
    }
}

/// Yedi global kısayol. `store_key()` Electron'un yazdığı anahtarlarla BİREBİR aynı
/// olmak zorunda — göç dosyayı olduğu gibi kopyalıyor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortcutKey {
    List,
    Draw,
    Video,
    Ocr,
    Color,
    Scroll,
    Paste,
}

impl ShortcutKey {
    pub const ALL: [ShortcutKey; 7] = [
        ShortcutKey::List,
        ShortcutKey::Draw,
        ShortcutKey::Video,
        ShortcutKey::Ocr,
        ShortcutKey::Color,
        ShortcutKey::Scroll,
        ShortcutKey::Paste,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ShortcutKey::List => "list",
            ShortcutKey::Draw => "draw",
            ShortcutKey::Video => "video",
            ShortcutKey::Ocr => "ocr",
            ShortcutKey::Color => "color",
            ShortcutKey::Scroll => "scroll",
            ShortcutKey::Paste => "paste",
        }
    }

    pub fn store_key(self) -> &'static str {
        match self {
            ShortcutKey::List => "globalShortcut",
            ShortcutKey::Draw => "globalShortcutImage",
            ShortcutKey::Video => "globalShortcutVideo",
            ShortcutKey::Ocr => "globalShortcutOcr",
            ShortcutKey::Color => "globalShortcutColor",
            ShortcutKey::Scroll => "globalShortcutScroll",
            ShortcutKey::Paste => "globalShortcutPaste",
        }
    }

    pub fn default(self) -> &'static str {
        match self {
            ShortcutKey::List => "Alt+V",
            ShortcutKey::Draw => "Alt+9",
            ShortcutKey::Video => "Alt+8",
            ShortcutKey::Ocr => "Alt+2",
            ShortcutKey::Color => "Alt+3",
            ShortcutKey::Scroll => "Alt+4",
            ShortcutKey::Paste => "CommandOrControl+Shift+V",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Arc<Store> {
        let mut p = std::env::temp_dir();
        p.push(format!("copyboard-state-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        Store::load(p)
    }

    #[test]
    fn varsayilanlar_electron_ile_ayni() {
        let s = AppState::new(store());
        let set = s.settings();
        assert_eq!(set.max_items(), 50);
        assert_eq!(set.quick_paste_count(), 20);
        assert!(set.auto_start());
        assert_eq!(set.video_quality(), "high");
        assert_eq!(set.widget_color(), "#8957e5");
        assert_eq!(set.widget_scale(), 100);
    }

    #[test]
    fn kisayol_store_anahtarlari_electron_ile_ayni() {
        // Bu eşleme bozulursa göç sonrası kullanıcının kısayolları sessizce
        // varsayılana döner — göç dosyayı olduğu gibi kopyalıyor.
        assert_eq!(ShortcutKey::List.store_key(), "globalShortcut");
        assert_eq!(ShortcutKey::Draw.store_key(), "globalShortcutImage");
        assert_eq!(ShortcutKey::Video.store_key(), "globalShortcutVideo");
        assert_eq!(ShortcutKey::Ocr.store_key(), "globalShortcutOcr");
        assert_eq!(ShortcutKey::Color.store_key(), "globalShortcutColor");
        assert_eq!(ShortcutKey::Scroll.store_key(), "globalShortcutScroll");
        assert_eq!(ShortcutKey::Paste.store_key(), "globalShortcutPaste");
    }

    #[test]
    fn eksik_shortcuts_enabled_anahtari_acik_sayilir() {
        // Gerçek kullanıcı dosyasında `shortcutsEnabled` içinde `scroll` YOKTU.
        let s = AppState::new(store());
        assert!(s.settings().shortcut_enabled(ShortcutKey::Scroll));
    }

    #[test]
    fn kisayol_kapatmak_baglamayi_korur() {
        let s = AppState::new(store());
        let set = s.settings();
        set.set_shortcut(ShortcutKey::Draw, "Alt+7");
        set.set_shortcut_enabled(ShortcutKey::Draw, false);
        assert!(!set.shortcut_enabled(ShortcutKey::Draw));
        assert_eq!(set.shortcut(ShortcutKey::Draw), "Alt+7", "kapatmak bağlamayı silmemeli");
        set.set_shortcut_enabled(ShortcutKey::Draw, true);
        assert_eq!(set.shortcut(ShortcutKey::Draw), "Alt+7");
    }
}
