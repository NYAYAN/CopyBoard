//! Pano geçmişi ve favori komutları.

use serde_json::Value;
use tauri::Manager;

use crate::clipboard::history;
use crate::state::AppState;

/// Panoya yaz + geçmişe ekle. `state.last_text` ÖNCEDEN kuruluyor ki izleyici
/// kendi yazdığımız değeri "yeni bir kopya" sanıp ikinci kez eklemesin.
pub fn write_and_record(app: &tauri::AppHandle, text: &str) {
    if text.is_empty() {
        return;
    }
    {
        let state = app.state::<AppState>();
        state.runtime.lock().unwrap().last_text = text.to_string();
    }
    let t = text.to_string();
    let h = app.clone();
    // Pano yazımı AppKit'e dokunuyor → ana thread.
    let _ = app.run_on_main_thread(move || {
        if !crate::platform::clipboard_write_text(&t) {
            log::error!("panoya yazılamadı");
        }
        history::add(&h, &t);
    });
}

/// Bir satır seçmek "bunu ver ve yoldan çekil" demektir — pencere gizlenir.
#[tauri::command]
pub async fn copy_item(app: tauri::AppHandle, text: String) {
    write_and_record(&app, &text);
    crate::windows::main_window::hide(&app);
}

/// Aynı yazma, gizleme YOK. Açık bir modalın (not detayı) içinden kopyalamak
/// pencerenin yerinde kalmasını gerektiriyor ki düğme onayını gösterebilsin.
#[tauri::command]
pub async fn copy_text(app: tauri::AppHandle, text: String) {
    write_and_record(&app, &text);
}

#[tauri::command]
pub async fn delete_history_item(app: tauri::AppHandle, id: String) {
    history::delete(&app, &id);
}

#[tauri::command]
pub async fn clear_history(app: tauri::AppHandle) {
    history::clear(&app);
}

#[tauri::command]
pub async fn add_to_favorites(app: tauri::AppHandle, item: Value) {
    history::add_favorite(&app, &item);
}

#[tauri::command]
pub async fn remove_from_favorites(app: tauri::AppHandle, id: String) {
    history::remove_favorite(&app, &id);
}

#[tauri::command]
pub async fn set_item_note(app: tauri::AppHandle, id: String, note: String) {
    history::set_note(&app, &id, &note);
}

#[tauri::command]
pub async fn reorder_history(app: tauri::AppHandle, history_items: Vec<Value>) {
    history::reorder(&app, "history", history_items);
}

#[tauri::command]
pub async fn reorder_favorites(app: tauri::AppHandle, favorites: Vec<Value>) {
    history::reorder(&app, "favorites", favorites);
}

/// Patolojik bir değerin belleği ve render maliyetini şişirmemesi için sınırlandırılıyor.
#[tauri::command]
pub async fn set_max_items(app: tauri::AppHandle, count: i64) {
    let n = count.clamp(1, 500);
    app.state::<AppState>().settings().set_max_items(n);
    history::trim_to_max(&app);
}

/// Hızlı yapıştır picker'ının kaç son kaydı göstereceği (1..100).
#[tauri::command]
pub async fn set_quickpaste_count(app: tauri::AppHandle, count: i64) {
    let n = count.clamp(1, 100);
    app.state::<AppState>().settings().set_quick_paste_count(n);
}
