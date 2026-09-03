//! Büyük görüntüleyici komutları.

use std::sync::Mutex;

use serde_json::Value;
use tauri::Manager;

use crate::state::AppState;
use crate::windows::viewer::LABEL;

/// Ekranda hangi görüntünün olduğu. Gezinme ve silme buna bakıyor.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// Alttaki şerit için küçük resimler.
fn strip(app: &tauri::AppHandle) -> Vec<Value> {
    crate::gallery::public_list(&app.state::<AppState>().store)
        .into_iter()
        .map(|s| serde_json::json!({ "id": s.get("id"), "thumb": s.get("thumb") }))
        .collect()
}

/// Renderer hazır olduğunu bildirdi — ilk durumu gönder.
pub fn send_initial_state(app: &tauri::AppHandle) {
    send_state(app);
}

/// Şeridi ve görüntüyü pencereye gönderir.
fn send_state(app: &tauri::AppHandle) {
    let Some(id) = CURRENT.lock().unwrap().clone() else { return };
    crate::windows::emit_to(app, LABEL, "viewer-list", strip(app));
    if let Some(payload) = super::gallery::payload_for(app, &id) {
        crate::windows::emit_to(app, LABEL, "viewer-image", payload);
    }
}

/// Galeriden ya da bağlam menüsünden açılış: pencere görüntüye göre boyutlanır.
pub fn open(app: &tauri::AppHandle, id: &str) {
    let Some(payload) = super::gallery::payload_for(app, id) else { return };
    let w = payload.get("w").and_then(|v| v.as_f64()).unwrap_or(800.0);
    let h = payload.get("h").and_then(|v| v.as_f64()).unwrap_or(600.0);

    *CURRENT.lock().unwrap() = Some(id.to_string());

    // `ensure` mevcut pencereyi döndürdüyse olaylar zaten bağlı; yalnız YENİ
    // pencerede bağlanıyor.
    let existed = tauri::Manager::get_webview_window(app, LABEL).is_some();
    match crate::windows::viewer::ensure(app, w, h) {
        Ok(window) => {
            if !existed {
                wire_events(app, &window);
            }
            let _ = window.show();
            let _ = window.set_focus();
            log::debug!(
                "görüntüleyici açıldı ({id}): mevcut={existed}, görünür={:?}, odak={:?}",
                window.is_visible(),
                window.is_focused()
            );
            send_state(app);
        }
        Err(e) => log::error!("görüntüleyici açılamadı: {e}"),
    }
}

/// Maksimize/geri al olaylarını bağlar. Araç çubuğundaki düğmenin, sürükleme
/// alanına çift tıklamayla ya da yapıştırma hareketiyle gelen maksimizeyi de
/// öğrenmesi gerekiyor — bu yüzden durum pencereden SORULUYOR, burada takip edilmiyor.
/// Olayları YENİ kurulan pencereye bağlar.
///
/// Önceki hâli süreç ömrü boyunca tek sefer izin veren statik bir bayrak kullanıyordu;
/// görüntüleyici kapatılıp yeniden açıldığında yeni pencereye hiçbir olay bağlanmıyor,
/// `viewer-window-state` gönderilmiyor ve maximize taşma düzeltmesi uygulanmıyordu.
/// Electron her yeni `BrowserWindow` için yeniden bağlıyordu.
fn wire_events(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let handle = app.clone();
    let w = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            let state = crate::windows::viewer::window_state(&w, &handle);
            crate::windows::emit_to(&handle, LABEL, "viewer-window-state", state);
        }
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            *CURRENT.lock().unwrap() = None;
        }
    });
}

/// Görüntüyü pencere ÖLÇÜSÜNE DOKUNMADAN değiştirir — ←/→ tuşları ve şerit
/// tıklamaları bunu kullanıyor, böylece pencere kullanıcının koyduğu yerde kalıyor.
fn show_id(app: &tauri::AppHandle, id: &str) {
    if super::gallery::payload_for(app, id).is_none() {
        return;
    }
    *CURRENT.lock().unwrap() = Some(id.to_string());
    send_state(app);
}

#[tauri::command]
pub async fn open_screenshot_viewer(app: tauri::AppHandle, id: String) {
    open(&app, &id);
}

/// ←/→: galeride adımla (yeniden-eskiye sıra, sarma yok).
pub fn nav(app: &tauri::AppHandle, dir: &str) {
    let Some(current) = CURRENT.lock().unwrap().clone() else { return };
    let list = crate::gallery::public_list(&app.state::<AppState>().store);
    let Some(idx) = list
        .iter()
        .position(|s| s.get("id").and_then(|i| i.as_str()) == Some(current.as_str()))
    else {
        return;
    };
    let target = if dir == "next" { idx.checked_add(1) } else { idx.checked_sub(1) };
    let Some(t) = target.and_then(|t| list.get(t)) else { return };
    if let Some(id) = t.get("id").and_then(|i| i.as_str()) {
        show_id(app, id);
    }
}

pub fn close(app: &tauri::AppHandle) {
    *CURRENT.lock().unwrap() = None;
    crate::windows::close_if_open(app, LABEL);
}

pub fn minimize(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.minimize();
    }
}

pub fn toggle_maximize(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let _ = if w.is_maximized().unwrap_or(false) { w.unmaximize() } else { w.maximize() };
}

// Komutlar `async`: pencereye dokunan iş IPC geri çağrısının içinde, ana thread'de
// senkron yapılırsa Windows'ta kilitleniyor (bkz. `commands/mod.rs`). Gövdeler yukarıdaki
// senkron yardımcılarda; `qa.rs` ve bağlam menüsü de onları çağırıyor.
#[tauri::command]
pub async fn viewer_nav(app: tauri::AppHandle, dir: String) {
    nav(&app, &dir);
}

#[tauri::command]
pub async fn viewer_select(app: tauri::AppHandle, id: String) {
    show_id(&app, &id);
}

#[tauri::command]
pub async fn viewer_close(app: tauri::AppHandle) {
    close(&app);
}

#[tauri::command]
pub async fn viewer_minimize(app: tauri::AppHandle) {
    minimize(&app);
}

#[tauri::command]
pub async fn viewer_toggle_maximize(app: tauri::AppHandle) {
    toggle_maximize(&app);
}

/// Karşılaştırma ızgarası TAM görüntüleri istiyor: görüntüleyicinin elinde bunlardan
/// tam olarak biri var (ekrandaki) artı şeridin 360 px'lik küçük resimleri, ve küçük
/// resim çözünürlüğünde yapılan bir karşılaştırma karşılaştırma değildir.
/// Çözümlenemeyen kimlikler uydurulmuyor, düşürülüyor.
#[tauri::command]
pub async fn viewer_compare_images(app: tauri::AppHandle, ids: Vec<String>) -> Vec<Value> {
    ids.iter()
        .filter_map(|id| {
            let p = super::gallery::payload_for(&app, id)?;
            Some(serde_json::json!({
                "id": p.get("id"), "dataUrl": p.get("dataUrl"), "size": p.get("size"),
                "w": p.get("w"), "h": p.get("h"), "timestamp": p.get("timestamp"),
            }))
        })
        .collect()
}

/// Düzenlenmiş kopya: görüntüleyici çizimini görüntünün üzerine düzleştirip (seçili
/// bölge varsa ona kırparak) bir PNG data URL gönderiyor. Galeriye KENDİ kaydı olarak
/// da giriyor — taze bir alıntıyla aynı mantık: düzenlenmiş sürüm bir sonraki pano
/// yazımından sonra da yaşasın.
#[tauri::command]
pub async fn viewer_copy_annotated(app: tauri::AppHandle, data_url: String) {
    let Some(png) = super::capture::decode_data_url_pub(&data_url) else {
        crate::windows::toast::show(&app, "Kopyalama Hatası: görüntü oluşturulamadı", "error");
        return;
    };
    if let Err(e) = super::capture::write_image_to_clipboard(&png) {
        crate::windows::toast::show(&app, &format!("Kopyalama Hatası: {e}"), "error");
        return;
    }
    let new_id = crate::gallery::add(&app, &png);
    crate::windows::toast::show(&app, "Düzenlenen resim kopyalandı.", "success");

    // Görüntüleyiciyi az önce dosyalanan kopyaya geçir: kullanıcı panoya tam olarak
    // ne gittiğini görür ve sonraki düzenlemeler onun üzerine biner. Ölçüye
    // dokunulmuyor. Galeri yazımı başarısızsa mevcut görüntüyü yeniden gönder ki
    // en azından şerit ve "3 / 26" sayacı dürüst kalsın.
    match new_id {
        Some(id) => show_id(&app, &id),
        None => send_state(&app),
    }
}

/// Her silme girişi (ızgara, bağlam menüsü, görüntüleyicinin kendi Sil düğmesi) buraya
/// geliyor; açık bir görüntüleyicinin düzeltilmesi de burada oluyor: ekrandaki görüntü
/// gidiyorsa komşuya adımla, sonuncuysa kapan, aksi hâlde şeridi ve sayacı tazele.
pub fn remove_shot(app: &tauri::AppHandle, id: &str) {
    let state = app.state::<AppState>();
    if crate::gallery::by_id(&state.store, id).is_none() {
        return;
    }
    // Komşular kayıt kaybolmadan ÖNCE okunmalı.
    let list = crate::gallery::public_list(&state.store);
    let idx = list
        .iter()
        .position(|s| s.get("id").and_then(|i| i.as_str()) == Some(id));
    let neighbour = idx.and_then(|i| list.get(i + 1).or_else(|| i.checked_sub(1).and_then(|p| list.get(p))))
        .and_then(|s| s.get("id").and_then(|v| v.as_str()).map(str::to_string));

    crate::gallery::delete(app, id);
    crate::windows::toast::show(app, "Ekran görüntüsü silindi.", "info");

    let current = CURRENT.lock().unwrap().clone();
    let Some(current) = current else { return };
    if current == id {
        match neighbour {
            Some(n) => show_id(app, &n),
            None => close(app),
        }
    } else {
        // Başka bir görüntü gitti: mevcut olanı yeniden gönder ki şerit ve sayaç
        // yeni listeye otursun (aynı id, ekranda hiçbir şey bozulmuyor).
        show_id(app, &current);
    }
}
