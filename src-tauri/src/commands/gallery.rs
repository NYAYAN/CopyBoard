//! Ekran görüntüsü galerisi komutları.

use serde_json::{json, Value};
use tauri::Manager;

use crate::state::AppState;

/// Izgara her (yeniden) yüklendiğinde bayat kayıtları temizle.
#[tauri::command]
pub async fn get_screenshots(app: tauri::AppHandle) -> Vec<Value> {
    crate::gallery::prune_missing(&app);
    crate::gallery::public_list(&app.state::<AppState>().store)
}

/// Dosyası hâlâ duruyorsa kaydı döndürür; uygulama dışından silinmişse bayat
/// indeks kaydını düşürür (bu da ızgarayı tazeler) ve kullanıcıya söyler.
fn shot_or_prune(app: &tauri::AppHandle, id: &str) -> Option<Value> {
    let state = app.state::<AppState>();
    let shot = crate::gallery::by_id(&state.store, id)?;
    let file = shot.get("file").and_then(|f| f.as_str())?;
    if std::path::Path::new(file).exists() {
        return Some(shot);
    }
    crate::gallery::delete(app, id);
    crate::windows::toast::show(app, "Dosya bulunamadı, galeriden kaldırıldı.", "info");
    None
}

#[tauri::command]
pub async fn copy_screenshot(app: tauri::AppHandle, id: String) {
    let Some(shot) = shot_or_prune(&app, &id) else { return };
    let Some(file) = shot.get("file").and_then(|f| f.as_str()) else { return };
    match std::fs::read(file) {
        Ok(png) => match super::capture::write_image_to_clipboard(&png) {
            Ok(()) => crate::windows::toast::show(&app, "Resim Kopyalandı.", "success"),
            Err(e) => crate::windows::toast::show(&app, &format!("Kopyalama Hatası: {e}"), "error"),
        },
        Err(e) => crate::windows::toast::show(&app, &format!("Kopyalama Hatası: {e}"), "error"),
    }
}

#[tauri::command]
pub async fn delete_screenshot(app: tauri::AppHandle, id: String) {
    super::viewer::remove_shot(&app, &id);
}

#[tauri::command]
pub async fn show_screenshot_file(app: tauri::AppHandle, id: String) {
    use tauri_plugin_opener::OpenerExt;
    let Some(shot) = shot_or_prune(&app, &id) else { return };
    if let Some(file) = shot.get("file").and_then(|f| f.as_str()) {
        if let Err(e) = app.opener().reveal_item_in_dir(file) {
            log::warn!("klasörde gösterilemedi: {e}");
        }
    }
}

/// Araç çubuğu eylemi: galeri KLASÖRÜNÜ aç (tek dosya değil). Dizin ilk kaydedilen
/// görüntüde tembelce oluşuyor, yani henüz var olmaması normal.
#[tauri::command]
pub async fn open_screenshot_folder(app: tauri::AppHandle) {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::gallery::screenshots_dir(&app);
    if !dir.exists() {
        crate::windows::toast::show(&app, "Henüz ekran görüntüsü yok.", "info");
        return;
    }
    if let Err(e) = app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>) {
        crate::windows::toast::show(&app, &format!("Klasör açılamadı: {e}"), "error");
    }
}

/// Küçük resme sağ tık: önizlemeyle aynı eylemleri taşıyan yerel bağlam menüsü.
///
/// `async`: `popup_menu` modal bir izleme döngüsü açıyor; IPC geri çağrısının içinde
/// açılırsa ana thread kilitleniyor (bkz. `commands/mod.rs`). Runtime thread'inden
/// çağrıldığında Tauri onu olay döngüsüne devrediyor.
#[tauri::command]
pub async fn screenshot_context_menu(app: tauri::AppHandle, window: tauri::WebviewWindow, id: String) {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    let state = app.state::<AppState>();
    if crate::gallery::by_id(&state.store, &id).is_none() {
        return;
    }
    let store = &state.store;
    let t = |k: &str| crate::i18n::t(store, k);

    let build = || -> tauri::Result<_> {
        MenuBuilder::new(&app)
            .item(&MenuItemBuilder::with_id(format!("shot-open:{id}"), t("Büyük Görüntüle")).build(&app)?)
            .item(&MenuItemBuilder::with_id(format!("shot-copy:{id}"), t("Kopyala")).build(&app)?)
            .item(&MenuItemBuilder::with_id(format!("shot-reveal:{id}"), t("Klasörde Göster")).build(&app)?)
            .separator()
            .item(&MenuItemBuilder::with_id(format!("shot-delete:{id}"), t("Sil")).build(&app)?)
            .build()
    };
    match build() {
        Ok(menu) => {
            if let Err(e) = window.popup_menu(&menu) {
                log::warn!("bağlam menüsü açılamadı: {e}");
            }
        }
        Err(e) => log::warn!("bağlam menüsü kurulamadı: {e}"),
    }
}

/// Bağlam menüsü seçimlerini yönlendirir. Kimlikler `eylem:id` biçiminde.
pub fn handle_context_menu(app: &tauri::AppHandle, menu_id: &str) -> bool {
    let Some((action, id)) = menu_id.split_once(':') else { return false };
    // Komutlar `async`: menü olayı ana thread'de geliyor, işi runtime'a devrediyoruz
    // (pencereye dokunan işleri ana thread'de senkron yapmak Windows'ta kilitliyor —
    // bkz. `commands/mod.rs` başındaki not).
    match action {
        "shot-open" => super::viewer::open(app, id),
        "shot-copy" => { tauri::async_runtime::spawn(copy_screenshot(app.clone(), id.to_string())); }
        "shot-reveal" => { tauri::async_runtime::spawn(show_screenshot_file(app.clone(), id.to_string())); }
        "shot-delete" => super::viewer::remove_shot(app, id),
        _ => return false,
    }
    true
}

/// Galerinin bir kaydını, renderer'ın beklediği tam yükle döndürür.
///
/// Dosya uygulama dışından silinmişse kayıt galeriden DÜŞÜRÜLÜR ve kullanıcıya
/// söylenir (Electron `shotDataUrl`): görüntüleyicide ölü bir küçük resme tıklamak
/// sessizce hiçbir şey yapmasın.
pub fn payload_for(app: &tauri::AppHandle, id: &str) -> Option<Value> {
    let shot = shot_or_prune(app, id)?;
    let file = shot.get("file").and_then(|f| f.as_str())?;
    let bytes = std::fs::read(file).ok()?;
    let state = app.state::<AppState>();
    let list = crate::gallery::public_list(&state.store);
    let pos = list
        .iter()
        .position(|s| s.get("id").and_then(|i| i.as_str()) == Some(id))?;

    Some(json!({
        "id": id,
        // Tam boy görüntü data URL olarak: `viewer.js` bunu doğrudan `img.src`'ye
        // veriyor ve dosya yolu okuma yetkisi istemiyor.
        "dataUrl": format!("data:image/png;base64,{}", crate::gallery::base64(&bytes)),
        "size": bytes.len(),
        "w": shot.get("w").cloned().unwrap_or(Value::Null),
        "h": shot.get("h").cloned().unwrap_or(Value::Null),
        "timestamp": shot.get("timestamp").cloned().unwrap_or(Value::Null),
        "pos": pos + 1,
        "total": list.len(),
    }))
}
