//! Otomatik güncelleme — `src/main/services/update-manager.js`'in karşılığı.
//!
//! ## macOS'ta da uygulama içi kurulum
//!
//! Electron sürümünde macOS'ta kapalıydı: Squirrel.Mac güncellemeyi yalnız Apple
//! imzalı uygulamaya uygulayabiliyordu ve diyalog kullanıcıyı GitHub'a yolluyordu.
//! Tauri'nin güncelleyicisinde o kısıt YOK: paketin minisign imzasını
//! `plugins.updater.pubkey` ile doğrulayıp `.app` paketini yerinde değiştiriyor
//! (NTerminal ad-hoc imzalı olduğu hâlde macOS'ta böyle güncelleniyor).
//!
//! İzinlerin güncellemeden sonra KORUNMASI ayrı bir şart: Ekran Kaydı ve
//! Erişilebilirlik imzanın "designated requirement"ına bağlı. CI paketleri yerel
//! derlemelerle aynı "CopyBoard Dev" sertifikasıyla imzaladığı için gereksinim
//! (`identifier … and certificate leaf = H…`) sürümler arasında aynı kalıyor;
//! ad-hoc imzalı bir güncelleme ise yayın akışında baştan durduruluyor
//! (bkz. .github/workflows/release-tauri.yml).
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
        // `latest.json`'ın `notes`'u: CHANGELOG.md'deki sürüm bölümü, MARKDOWN
        // (bkz. scripts/release-files.mjs; electron-updater HTML veriyordu).
        // Diyalog ikisini de tanıyor.
        "releaseNotes": update.body.clone().unwrap_or_default(),
        "releaseName": update.version,
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

/// Geri sayım bitti: indirilen paketi kur.
///
/// `async` OLMAK ZORUNDA: senkron komutlar ana thread'de koşuyor. macOS'ta paketin
/// yerine yazılamazsa eklenti yönetici parolası istemini ana thread'e gönderip
/// sonucunu BEKLİYOR; komut ana thread'de olsaydı kendi kendini bekleyip kilitlenirdi
/// (NTerminal'de yaşanan ders).
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) {
    if let Err(e) = install_downloaded(&app) {
        emit_error(&app, e);
    }
}

/// Windows'ta eklenti NSIS'i başlatıp süreci KENDİSİ sonlandırıyor (Electron
/// `quitAndInstall` karşılığı) — `install` başarıda geri dönmüyor. macOS'ta ise `.app`
/// paketini yerinde değiştirip DÖNÜYOR; yeni sürüme geçmek için yeniden başlatmak
/// bize kalıyor. Yeniden başlatma bilerek yalnız macOS'ta: Windows'ta buraya
/// ulaşmak kurulumun başlamadığı demek ve yeniden başlatma ESKİ sürümü açardı.
///
/// `restart` değil `request_restart`: `restart` ana thread'de kapanış olaylarını
/// ATLIYOR. Tek-örnek eklentisinin soketi yalnız `RunEvent::Exit`te siliniyor;
/// atlanınca yeni süreç, henüz ölmemiş eski sürecin soketine bağlanıp "zaten açık"
/// diyerek çıkabiliyordu — güncellemeden sonra uygulama hiç geri gelmezdi.
/// `request_restart` olayları sırayla işletiyor (izleyici durur, kısayollar
/// bırakılır, soket silinir), yeni süreci olay döngüsü bittikten SONRA açıyor.
fn install_downloaded(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = PENDING.lock().unwrap().take();
    let Some((update, bytes)) = DOWNLOADED.lock().unwrap().take() else {
        return Err(t(app, "İndirilmiş güncelleme bulunamadı."));
    };
    // Bekleyen pano yazması kurulumdan önce diske insin.
    app.state::<crate::state::AppState>().store.flush();
    update.install(bytes).map_err(|e| {
        log::error!("güncelleme kurulamadı: {e}");
        e.to_string()
    })?;
    #[cfg(target_os = "macos")]
    {
        log::info!("[updater] güncelleme kuruldu — yeni sürümle yeniden başlatılıyor");
        app.request_restart();
    }
    Ok(())
}

/// `--qa-update` (yalnız hata ayıklama derlemesi): diyaloğun düğmelerinin çağırdığı
/// komutları SIRAYLA koşturur — indir (imza doğrulaması dahil) → kur → yeniden
/// başlat. Uç noktası yerel bir `latest.json`'a çevrilmiş bir pakette anlamlı;
/// adımlar RELEASE_GUIDE.md "Güncellemeyi yerelde uçtan uca sınamak"ta.
#[cfg(debug_assertions)]
pub fn qa_run(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Açılış otursun, ama zincir açılıştaki sessiz kontrolden (5 sn) ÖNCE bitsin
        // ki güncelleme diyaloğu araya girmesin.
        crate::tokio_sleep(1000).await;
        log::info!("QA-UPDATE başlıyor: kurulu sürüm {}", app.package_info().version);
        download_update(app.clone()).await;
        if DOWNLOADED.lock().unwrap().is_none() {
            println!("QAU SONUC: indirme ya da imza doğrulaması başarısız (ayrıntı günlükte)");
            app.exit(1);
            return;
        }
        log::info!("QA-UPDATE: indirildi ve imza doğrulandı — kuruluyor");
        if let Err(e) = install_downloaded(&app) {
            println!("QAU SONUC: kurulum başarısız: {e}");
            app.exit(1);
        }
    });
}
