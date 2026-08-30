//! Kısayol komutları.
//!
//! Yedi ayrı kanal yerine tek bir komut da olabilirdi, ama `preload.js`'in yüzeyi
//! birebir korunuyor (`setShortcut`, `setImageShortcut`, …) — `api-tauri.js` bunları
//! tek bir komuta indiriyor.

use crate::state::ShortcutKey;

fn key_from(name: &str) -> Option<ShortcutKey> {
    Some(match name {
        "list" => ShortcutKey::List,
        "draw" => ShortcutKey::Draw,
        "video" => ShortcutKey::Video,
        "ocr" => ShortcutKey::Ocr,
        "color" => ShortcutKey::Color,
        "scroll" => ShortcutKey::Scroll,
        "paste" => ShortcutKey::Paste,
        _ => return None,
    })
}

#[tauri::command]
pub fn set_shortcut(app: tauri::AppHandle, key: String, accelerator: String) {
    let Some(k) = key_from(&key) else {
        log::warn!("bilinmeyen kısayol anahtarı: {key}");
        return;
    };
    crate::shortcuts::update(&app, k, &accelerator);
}

#[tauri::command]
pub fn set_shortcut_enabled(app: tauri::AppHandle, key: String, enabled: bool) {
    let Some(k) = key_from(&key) else {
        log::warn!("bilinmeyen kısayol anahtarı: {key}");
        return;
    };
    crate::shortcuts::set_enabled(&app, k, enabled);
}
