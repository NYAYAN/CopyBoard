//! Pencere "hazırım" el sıkışması.
//!
//! ## Neden gerekli — BULGU F1-c, üç kez karşımıza çıktı
//!
//! Electron'da `ipcRenderer.on` SENKRONDU: preload çalıştığı anda dinleyici kuruluydu
//! ve ana süreç `did-finish-load`'da veri itebiliyordu. Tauri'de `listen()` bir PROMISE
//! döndürüyor ve dinleyici ancak o çözüldüğünde kuruluyor.
//!
//! Sonuç: ana süreç "pencere yüklendi" diye veri yayınlarsa, dinleyici henüz kurulmamış
//! olabilir ve **mesaj sessizce düşer**. Bu, üretimde "bazen boş açılıyor" diye
//! kovalanacak türden bir hata.
//!
//! | Nerede çıktı | Belirti |
//! |---|---|
//! | Toast | pencere görünür ama mesaj yok |
//! | Görüntüleyici | araç çubuğu var, görüntü alanı boş |
//! | Güncelleme diyaloğu | sürüm bilgisi gelmiyor |
//!
//! Çözüm tek ve genel: renderer dinleyicilerini kurar, SONRA `window_ready` çağırır;
//! ana süreç ilk durumu ancak o zaman gönderir. Yakalama overlay'i zaten bu modeli
//! kullanıyordu (kareyi kendisi ÇEKİYOR), o yüzden orada bu hata hiç olmadı.

/// Renderer dinleyicilerini kurdu ve ilk durumu almaya hazır.
#[tauri::command]
pub async fn window_ready(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    match window.label() {
        crate::windows::toast::LABEL => crate::windows::toast::ready(&app),
        crate::windows::viewer::LABEL => super::viewer::send_initial_state(&app),
        crate::windows::update::LABEL => crate::updater::update_dialog_ready(&app),
        crate::windows::quickpaste::LABEL => crate::windows::quickpaste::ready(&app),
        crate::windows::widget::LABEL => {
            crate::windows::widget::notify_side(&app);
            crate::windows::widget::push_config(&app);
            crate::clipboard::history::push_snapshot(&app, crate::windows::widget::LABEL);
        }
        crate::windows::main_window::LABEL => {
            crate::clipboard::history::push_snapshot(&app, crate::windows::main_window::LABEL);
            crate::gallery::broadcast(&app);
        }
        other if other.starts_with(crate::windows::capture::PREFIX) => {
            crate::capture::window_ready(&app, other)
        }
        other => log::debug!("'{other}' penceresi hazır (ilk durum gerektirmiyor)"),
    }
}
