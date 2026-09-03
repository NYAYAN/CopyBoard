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
//!
//! ## İndir ve kur AYRI adımlar
//!
//! Eklentinin `download_and_install`'ı Windows'ta NSIS'i başlatıp süreci hemen
//! `exit(0)` ile bitiriyor. Diyalog ise Electron'daki gibi bir durum makinesi bekliyor:
//! `download-progress` → `update-downloaded` → 3-2-1 geri sayım → `install_update`.
//! O yüzden burada önce yalnız İNDİRİLİYOR (baytlar bellekte tutuluyor), diyalog
//! "İndirme Tamamlandı" diyip geri sayıyor ve kurulum ayrı bir komutla yapılıyor.
//! Kullanıcı geri sayımı "Daha Sonra" ile iptal edebiliyor — `download_and_install`
//! ile bu imkânsızdı.
//!
//! ## `pubkey` boşsa
//!
//! Güncelleyici imza doğrulaması için `plugins.updater.pubkey` ister. Boşken `check()`
//! çalışıyor ama indirme ham bir minisign hatasıyla düşüyor. Bu yapı yapılandırılmamış
//! sayılır: açılış kontrolü atlanır, elle kontrol anlaşılır bir mesaj verir.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

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

fn t(app: &tauri::AppHandle, key: &str) -> String {
    crate::i18n::t(&app.state::<crate::state::AppState>().store, key)
}

/// `plugins.updater.pubkey` dolu mu? Boşsa güncelleyici bu yapıda çalışamaz.
pub fn is_configured(app: &tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

async fn check(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// Kullanıcının bastığı "Güncellemeleri Denetle".
pub async fn check_manual(app: tauri::AppHandle) {
    if !is_configured(&app) {
        log::warn!("[updater] pubkey boş — güncelleyici bu yapıda yapılandırılmamış");
        let msg = t(&app, "Güncelleyici bu yapıda yapılandırılmamış. Yeni sürümler için GitHub sayfasına bakın.");
        crate::windows::toast::show(&app, &msg, "warning");
        return;
    }
    MANUAL_CHECK.store(true, Ordering::Release);

    match check(&app).await {
        Ok(Some(update)) => {
            MANUAL_CHECK.store(false, Ordering::Release); // yanıtı dialog veriyor
            open_dialog(&app, &update);
        }
        Ok(None) => {
            if claim_manual_report() {
                let msg = t(&app, "Zaten en güncel sürümü kullanıyorsunuz.");
                crate::windows::toast::show(&app, &msg, "info");
            }
        }
        Err(e) => {
            log::error!("güncelleme kontrolü başarısız: {e}");
            if claim_manual_report() {
                let msg = t(&app, "Güncelleme kontrolü başarısız oldu");
                crate::windows::toast::show(&app, &msg, "error");
            }
        }
    }
}

/// Açılıştaki sessiz kontrol: "güncelleme yok" ve hatalar SESSİZ kalır; yalnız
/// mevcut bir güncelleme dialogu açar.
pub async fn check_silent(app: tauri::AppHandle) {
    if !is_configured(&app) {
        log::info!("[updater] pubkey boş — açılış kontrolü atlandı");
        return;
    }
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
        // tauri-action `latest.json`'a release gövdesini MARKDOWN olarak yazıyor
        // (electron-updater HTML veriyordu). Diyalog ikisini de tanıyor.
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

static PENDING: Mutex<Option<String>> = Mutex::new(None);
static INFO: Mutex<Option<serde_json::Value>> = Mutex::new(None);
/// İndirilmiş paket: kurulum ayrı komutla yapılıyor (bkz. modül başı).
static DOWNLOADED: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>> = Mutex::new(None);

/// Güncelleme diyaloğu dinleyicilerini kurdu — `window_ready` üzerinden çağrılıyor.
/// Ayrı bir komut olarak AÇILMIYOR: renderer genel el sıkışmasını kullanıyor,
/// ikinci bir giriş noktası yalnızca ıraksama riski olurdu.
pub fn update_dialog_ready(app: &tauri::AppHandle) {
    if let Some(info) = INFO.lock().unwrap().clone() {
        crate::windows::emit_to(app, crate::windows::update::LABEL, "update-info", info);
    }
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) {
    check_manual(app).await;
}

fn emit_error(app: &tauri::AppHandle, message: String) {
    crate::windows::emit_to(app, crate::windows::update::LABEL, "update-error", message);
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
        // Diyalog "İndiriliyor…"da kilitli kalmasın: Electron her başarısızlıkta
        // `update-error` yayınlıyordu.
        Ok(None) => {
            emit_error(&app, t(&app, "Güncelleme bulunamadı."));
            return;
        }
        Err(e) => {
            emit_error(&app, e);
            return;
        }
    };

    let total = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let got = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let started = Instant::now();
    let (tt, g, h) = (total.clone(), got.clone(), app.clone());

    let result = update
        .download(
            move |chunk, content_length| {
                if let Some(len) = content_length {
                    tt.store(len, Ordering::Relaxed);
                }
                let done = g.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let len = tt.load(Ordering::Relaxed);
                let percent = if len > 0 { done as f64 / len as f64 * 100.0 } else { 0.0 };
                let secs = started.elapsed().as_secs_f64().max(0.001);
                crate::windows::emit_to(
                    &h,
                    crate::windows::update::LABEL,
                    "download-progress",
                    serde_json::json!({
                        "percent": percent,
                        "transferred": done,
                        "total": len,
                        // electron-updater'ın `bytesPerSecond`'ı; diyalog hızı bununla gösteriyor.
                        "bytesPerSecond": (done as f64 / secs).round(),
                    }),
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            *DOWNLOADED.lock().unwrap() = Some((update, bytes));
            crate::windows::emit_to(&app, crate::windows::update::LABEL, "update-downloaded", ());
        }
        Err(e) => {
            log::error!("güncelleme indirilemedi: {e}");
            emit_error(&app, e.to_string());
        }
    }
}

/// Geri sayım bitti: indirilen paketi kur. Windows'ta eklenti NSIS'i başlatıp süreci
/// kendisi sonlandırıyor (Electron `quitAndInstall` karşılığı).
#[tauri::command]
pub fn install_update(app: tauri::AppHandle) {
    if is_mac() {
        log::warn!("[updater] macOS'ta yeniden başlatma atlandı (imzasız uygulama)");
        return;
    }
    let _ = PENDING.lock().unwrap().take();
    let Some((update, bytes)) = DOWNLOADED.lock().unwrap().take() else {
        emit_error(&app, t(&app, "İndirilmiş güncelleme bulunamadı."));
        return;
    };
    // Bekleyen pano yazması kurulumdan önce diske insin.
    app.state::<crate::state::AppState>().store.flush();
    if let Err(e) = update.install(bytes) {
        log::error!("güncelleme kurulamadı: {e}");
        emit_error(&app, e.to_string());
    }
}
