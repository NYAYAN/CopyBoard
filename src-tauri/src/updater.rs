//! Otomatik güncelleme — `src/main/services/update-manager.js`'in karşılığı.
//!
//! ## macOS'ta neden devre dışı
//!
//! Uygulama macOS'ta imzasız dağıtılıyor. Electron sürümünde Squirrel.Mac güncellemeyi
//! uygulayamıyordu ve dialog kullanıcıyı GitHub'dan elle indirmeye yönlendiriyordu.
//! Aynı politika korunuyor: `download` macOS'ta baştan reddediliyor, böylece ana süreç
//! başarısız olacağı belli bir indirmeye hiç başlamıyor.
//!
//! ## Elle kontrol HER ZAMAN yanıt vermeli
//!
//! "Zaten güncelsiniz", "işte bir güncelleme" ya da neden olmadığı — hiçbir şey
//! söylememek ölü bir düğmeden ayırt edilemez. `manual_check` bayrağı yanıtın TAM
//! OLARAK BİR KEZ verilmesini sağlıyor: ilk raporlayan bayrağı temizliyor.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

static MANUAL_CHECK: AtomicBool = AtomicBool::new(false);

/// Elle başlatılan kontrol için yanıt hakkını tüket. `true` dönerse rapor bizim.
fn claim_manual_report() -> bool {
    MANUAL_CHECK.swap(false, Ordering::AcqRel)
}

fn is_mac() -> bool {
    cfg!(target_os = "macos")
}

async fn check(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// Kullanıcının bastığı "Güncellemeleri Denetle".
pub async fn check_manual(app: tauri::AppHandle) {
    MANUAL_CHECK.store(true, Ordering::Release);

    match check(&app).await {
        Ok(Some(update)) => {
            MANUAL_CHECK.store(false, Ordering::Release); // yanıtı dialog veriyor
            open_dialog(&app, &update);
        }
        Ok(None) => {
            if claim_manual_report() {
                let msg = crate::i18n::t(&app.state::<crate::state::AppState>().store, "Zaten en güncel sürümü kullanıyorsunuz.");
                crate::windows::toast::show(&app, &msg, "info");
            }
        }
        Err(e) => {
            log::error!("güncelleme kontrolü başarısız: {e}");
            if claim_manual_report() {
                crate::windows::toast::show(&app, "Güncelleme kontrolü başarısız oldu", "error");
            }
        }
    }
}

/// Açılıştaki sessiz kontrol: "güncelleme yok" ve hatalar SESSİZ kalır; yalnız
/// mevcut bir güncelleme dialogu açar.
pub async fn check_silent(app: tauri::AppHandle) {
    match check(&app).await {
        Ok(Some(update)) => open_dialog(&app, &update),
        Ok(None) => log::debug!("güncelleme yok"),
        Err(e) => log::error!("açılış güncelleme kontrolü başarısız: {e}"),
    }
}

fn open_dialog(app: &tauri::AppHandle, update: &tauri_plugin_updater::Update) {
    let info = serde_json::json!({
        "version": update.version,
        "currentVersion": app.package_info().version.to_string(),
        "releaseNotes": update.body.clone().unwrap_or_default(),
        "releaseName": update.version,
        "isMac": is_mac(),
    });
    PENDING.lock().unwrap().replace(update.version.clone());

    match crate::windows::update::ensure(app) {
        Ok(_) => {
            // Pencere yeni kurulduysa sayfa henüz dinlemiyor olabilir; renderer
            // `onUpdateInfo` dinleyicisini kurunca `update_dialog_ready` ile
            // bilgiyi ÇEKİYOR (BULGU F1-c'nin aynısı).
            *INFO.lock().unwrap() = Some(info);
        }
        Err(e) => log::error!("güncelleme penceresi açılamadı: {e}"),
    }
}

static PENDING: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static INFO: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

/// Güncelleme penceresi hazır — bekleyen bilgiyi teslim et.
#[tauri::command]
pub fn update_dialog_ready(app: tauri::AppHandle) {
    if let Some(info) = INFO.lock().unwrap().clone() {
        crate::windows::emit_to(&app, crate::windows::update::LABEL, "update-info", info);
    }
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) {
    check_manual(app).await;
}

#[tauri::command]
pub async fn download_update(app: tauri::AppHandle) {
    if is_mac() {
        // Savunma derinliği: dialog macOS kullanıcısını elle indirmeye yönlendiriyor,
        // ama ana süreç de baştan kaybedeceği bir indirmeye başlamamalı.
        log::warn!("[updater] macOS'ta uygulama içi indirme atlandı (imzasız uygulama)");
        return;
    }
    let update = match check(&app).await {
        Ok(Some(u)) => u,
        Ok(None) => return,
        Err(e) => {
            crate::windows::emit_to(&app, crate::windows::update::LABEL, "update-error", e);
            return;
        }
    };

    let total = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let got = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let (t, g, h) = (total.clone(), got.clone(), app.clone());

    let result = update
        .download_and_install(
            move |chunk, content_length| {
                if let Some(len) = content_length {
                    t.store(len, Ordering::Relaxed);
                }
                let done = g.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let len = t.load(Ordering::Relaxed);
                let percent = if len > 0 { done as f64 / len as f64 * 100.0 } else { 0.0 };
                crate::windows::emit_to(
                    &h,
                    crate::windows::update::LABEL,
                    "download-progress",
                    serde_json::json!({ "percent": percent, "transferred": done, "total": len }),
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => crate::windows::emit_to(&app, crate::windows::update::LABEL, "update-downloaded", ()),
        Err(e) => {
            log::error!("güncelleme indirilemedi: {e}");
            crate::windows::emit_to(&app, crate::windows::update::LABEL, "update-error", e.to_string());
        }
    }
}

#[tauri::command]
pub fn install_update(app: tauri::AppHandle) {
    if is_mac() {
        log::warn!("[updater] macOS'ta yeniden başlatma atlandı (imzasız uygulama)");
        return;
    }
    let _ = PENDING.lock().unwrap().take();
    app.restart();
}
