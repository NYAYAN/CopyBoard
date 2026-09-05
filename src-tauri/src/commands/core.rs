//! Çekirdek komutlar: açılış verisi, ayarlar, pencere kontrolü, toast.

use serde_json::{json, Value};
use tauri::Manager;

use crate::state::{AppState, ShortcutKey};
use crate::windows::{main_window, toast};

/// Renderer'ın açılışta çektiği geçmiş + favoriler.
#[tauri::command]
pub fn get_history(state: tauri::State<'_, AppState>) -> Value {
    crate::clipboard::history::snapshot(&state.store)
}

/// Ayarlar ekranının tamamı. Anahtar isimleri Electron'un `get-settings`
/// yanıtıyla BİREBİR aynı — `settings-ui.js` bunları doğrudan okuyor.
#[tauri::command]
pub fn get_settings(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Value {
    let s = state.settings();
    let mut enabled = serde_json::Map::new();
    for key in ShortcutKey::ALL {
        enabled.insert(key.as_str().into(), json!(s.shortcut_enabled(key)));
    }

    json!({
        "appVersion": app.package_info().version.to_string(),
        "maxItems": s.max_items(),
        "quickPasteCount": s.quick_paste_count(),
        "globalShortcut": s.shortcut(ShortcutKey::List),
        "globalShortcutImage": s.shortcut(ShortcutKey::Draw),
        "globalShortcutVideo": s.shortcut(ShortcutKey::Video),
        "globalShortcutOcr": s.shortcut(ShortcutKey::Ocr),
        "globalShortcutColor": s.shortcut(ShortcutKey::Color),
        "globalShortcutScroll": s.shortcut(ShortcutKey::Scroll),
        "globalShortcutPaste": s.shortcut(ShortcutKey::Paste),
        "shortcutsEnabled": Value::Object(enabled),
        "autoStart": s.auto_start(),
        "videoQuality": s.video_quality(),
        "audioMicDevice": s.audio_mic_device(),
        "clipboardPaused": s.clipboard_paused(),
        "showWidget": s.show_widget(),
        "widgetTransparent": s.widget_transparent(),
        "widgetColor": s.widget_color(),
        "widgetOpacity": s.widget_opacity(),
        "widgetScale": s.widget_scale(),
    })
}

#[tauri::command]
pub async fn set_autostart(app: tauri::AppHandle, value: bool) {
    use tauri_plugin_autostart::ManagerExt;

    // `async` komut `State<'_>` alamıyor; içeriden çekiliyor.
    let state = app.state::<AppState>();
    state.settings().set_auto_start(value);
    // Geliştirme sürümü OS'a hiç kayıt yazmaz (Electron `app.isPackaged`): tercih
    // saklanır, paketli sürüm açılışta `sync_autostart` ile uygular.
    if tauri::is_dev() {
        return;
    }
    let mgr = app.autolaunch();
    let result = if value { mgr.enable() } else { mgr.disable() };
    if let Err(e) = result {
        log::warn!("otomatik başlatma ayarlanamadı: {e}");
        // Ayar ile gerçek durum ayrışmasın: OS reddettiyse tercihi geri al ve
        // ayarlar ekranına söyle — yoksa onay kutusu yeni konumunda yalan söylüyor.
        state.settings().set_auto_start(!value);
        let store = &state.store;
        let msg = crate::i18n::t(store, "Otomatik başlatma ayarlanamadı. İşletim sistemi isteği reddetti.");
        toast::show(&app, &msg, "error");
    }
}

#[tauri::command]
pub fn set_clipboard_paused(state: tauri::State<'_, AppState>, value: bool) {
    state.settings().set_clipboard_paused(value);
}

/// Ana pencereyi gizler (kapatmaz) — tepsi uygulaması, X düğmesi çıkış değil.
#[tauri::command]
pub async fn close_window(app: tauri::AppHandle) {
    main_window::hide(&app);
}

/// Çağıran pencereyi küçültür.
#[tauri::command]
pub async fn minimize_window(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

/// Sayfanın `window.close()` çağrısının karşılığı (bkz. `api-tauri.js`).
///
/// Electron'da `window.close()` BrowserWindow'u kapatıyordu; WKWebView bunu
/// script'in açmadığı pencerelerde yok sayıyor. Ana pencere için "kapat" gizlemek
/// demek (tepsi uygulaması); geri kalan her pencere gerçekten kapanıyor.
#[tauri::command]
pub async fn close_current_window(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    if window.label() == main_window::LABEL {
        main_window::hide(&app);
        return;
    }
    if let Err(e) = window.close() {
        log::warn!("{} penceresi kapatılamadı: {e}", window.label());
    }
}

#[tauri::command]
pub async fn toast_finished(app: tauri::AppHandle) {
    toast::finished(&app);
}

#[tauri::command]
pub async fn toast_resize(app: tauri::AppHandle, height: f64) {
    toast::resize(&app, height);
}

/// Renderer'dan hata ayıklama günlüğü. Electron'daki `debug-log` kanalı.
#[tauri::command]
pub fn debug_log(message: String) {
    if message == "snip-painted" {
        if let Some(ms) = crate::capture::elapsed_since_begin_ms() {
            log::info!("PERF snip-painted +{ms} ms");
        }
    }
    // Yakalama harness'ı (`--qa-capture`) renderer'dan Rust'a değer geçirmek için
    // bu yolu kullanıyor: Tauri'de `eval` bir değer DÖNDÜRMÜYOR ve yalnız sınama
    // için ayrı bir komut açmak, sürüm derlemesinde de duran bir yüzey bırakırdı.
    #[cfg(debug_assertions)]
    if let Some(rest) = message.strip_prefix("QAC ") {
        crate::qa_capture::probe(rest);
    }
    log::info!("[renderer] {message}");
}

/// Dil değişimi. Her pencere kendi metinlerini yüklenirken boyadığı için
/// yeniden yükleme TÜM güncellemedir — senkronda tutulacak per-surface
/// yeniden çizim kodu yok. Pencere durumu Rust tarafında yaşıyor, hiçbir şey kaybolmaz.
/// Dil değişimi.
///
/// Her pencere kendi metinlerini yüklenirken boyadığı için yeniden yükleme TÜM
/// güncellemedir — senkronda tutulacak per-surface yeniden çizim kodu yok.
///
/// ## ⚠ Neden `sessionStorage`
///
/// İlk hâli sözlüğü `eval` ile yamalayıp `location.reload()` çağırıyordu. Bu
/// ÇALIŞMIYORDU: `initialization_script` her sayfa yüklemesinde yeniden enjekte
/// ediliyor ve pencere kurulurken sabitlenen ESKİ sözlükle `__COPYBOARD_BOOT__`ı
/// yeniden yazıp yamayı eziyordu. Ölçüldü: ayar diske yazılıyor, arayüz Türkçe
/// kalıyor, yalnız uygulamayı yeniden başlatınca değişiyordu.
///
/// Çözüm: açılış verisi artık `sessionStorage`'dan okunuyor (bkz.
/// `windows::boot_script`). Reload öncesi oraya TAZE yük yazılıyor ve init script
/// onu tercih ediyor. `sessionStorage` webview oturumuna bağlı, yani pencere
/// kapanınca temizleniyor ve bayat veri bırakmıyor.
#[tauri::command]
pub async fn set_language(app: tauri::AppHandle, lang: String) {
    apply_language(&app, &lang);
}

/// Senkron gövde — komut ve `--set-lang` hata ayıklama bayrağı ikisi de bunu çağırıyor.
pub fn apply_language(app: &tauri::AppHandle, lang: &str) {
    let state = app.state::<AppState>();
    if !crate::i18n::set_language(&state.store, lang) {
        return;
    }
    let os_dark = os_prefers_dark(app);
    let boot = crate::windows::boot_payload(app, os_dark);
    let script = format!(
        "try {{ sessionStorage.setItem('__COPYBOARD_BOOT__', JSON.stringify({boot})); }} catch (e) {{}} location.reload();"
    );
    // Yeniden yükleme dinleyicileri düşürüyor; "hazır" bayrakları da düşmeli, yoksa
    // arada gösterilen bir toast / seçici, dinleyicisi olmayan sayfaya yayınlanıp
    // kaybolur. `window_ready` yeniden gelince bekleyenler teslim ediliyor.
    state.runtime.lock().unwrap().toast_ready = false;
    crate::windows::quickpaste::reset_ready();
    for (_, window) in app.webview_windows() {
        let _ = window.eval(&script);
    }
    // Menü etiketleri de t() ile üretiliyor; yeniden inşa edilmezse eski dilde kalır.
    crate::tray::rebuild(app);
}

/// Tema değişimi. Dilin aksine hiçbir şey yeniden YÜKLENMEZ: her pencere olayı alıp
/// `<html data-theme>` bayrağını çevirir. Geçiş anında olur ve iş ortasında zararsızdır —
/// alıntı overlay'i ve kaydedici, altınızdan yeniden yüklenmesini istemeyeceğiniz pencerelerdir.
#[tauri::command]
pub async fn set_theme(app: tauri::AppHandle, value: String) {
    let state = app.state::<AppState>();
    if !crate::theme::set_mode(&state.store, &value) {
        return;
    }
    broadcast_theme(&app);
}

pub fn broadcast_theme(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let os_dark = os_prefers_dark(app);
    let resolved = crate::theme::resolved(&state.store, os_dark);
    let _ = app.emit("theme-changed", resolved);
}

/// OS koyu temada mı? Sıra: ana pencerenin `theme()`u (varsa) → OS'a doğrudan soru
/// (pencere yokken, ilk pencere kurulurken) → koyu varsayımı.
pub fn os_prefers_dark(app: &tauri::AppHandle) -> bool {
    if let Some(w) = app.get_webview_window(main_window::LABEL) {
        #[cfg(target_os = "macos")]
        {
            return crate::platform::macos::os_prefers_dark(&w);
        }
        #[cfg(not(target_os = "macos"))]
        if let Ok(t) = w.theme() {
            return matches!(t, tauri::Theme::Dark);
        }
    }
    crate::platform::os_prefers_dark_hint().unwrap_or(true)
}
