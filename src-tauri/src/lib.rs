//! CopyBoard — Tauri sürümü.
//!
//! Electron sürümünün ana süreci (`src/main/**`, 3.704 satır) buraya taşınıyor.
//! Renderer (`src/renderer/**`) DEĞİŞMİYOR: `api-tauri.js` eski `window.api`
//! yüzeyini birebir taklit ediyor.
//!
//! Faz 1 kapsamı: iskelet, store + göç, i18n/tema, pencere fabrikası, ana pencere,
//! toast, çekirdek komutlar. Pano izleyici, kısayollar, tepsi, yakalama ve OCR
//! sonraki fazlarda.

pub mod capture;
pub mod clipboard;
pub mod commands;
#[cfg(debug_assertions)]
pub mod dbgtrace;
pub mod gallery;
pub mod geom;
pub mod i18n;
pub mod migrate;
pub mod ocr;
pub mod platform;
#[cfg(debug_assertions)]
pub mod qa;
pub mod shortcuts;
pub mod state;
pub mod store;
pub mod theme;
pub mod tray;
pub mod updater;
mod videos;
pub mod windows;

use tauri::Manager;

use crate::state::AppState;
use crate::store::Store;
use crate::windows::{main_window, toast};

/// Otomatik başlatmayla açıldığında pencere gösterilmez.
const HIDDEN_FLAG: &str = "--hidden";

pub fn run() {
    install_panic_hook();

    tauri::Builder::default()
        // Tek örnek kilidi İLK eklenti: ikinci kopya, günlük dosyasına ya da başka
        // bir eklentiye dokunmadan var olanı öne getirip çıksın (eklenti belgesi de
        // bunu istiyor).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            main_window::show(app);
        }))
        // Günlükleme. Olmadan `log::` çağrılarının tamamı sessizce yok oluyor —
        // ilk çalıştırmada tam olarak bu oldu ve pencerenin neden görünmediği
        // görünmez kaldı. Konsola VE dosyaya yazıyor; dosya, kullanıcıda çıkan
        // bir sorunu istemenin tek makul yolu.
        //
        // Dosya: macOS `~/Library/Logs/com.nurullahyayan.copyboard/copyboard.log`,
        // Windows `%LOCALAPPDATA%\com.nurullahyayan.copyboard\logs\copyboard.log`.
        .plugin(
            tauri_plugin_log::Builder::new()
                // Geliştirmede Debug, paketlenmiş sürümde Info: Debug seviyesi
                // pencere yerleşimi gibi ayrıntıları basıyor ve bunlar bir
                // kullanıcı günlüğünde gürültüden ibaret.
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                // Eklentinin varsayılanı 40 KB ve dolunca dosyayı SİLİYOR; renderer'ın
                // warn/error'ları da buraya aktığı için "kullanıcıdan log iste" planı
                // birkaç yüz satıra sığıyordu. 4 MB, günlerce geçmiş demek.
                .max_file_size(4 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                // Kullanıcının saatiyle: UTC damgaları, "saat 14:03'te oldu" ile
                // eşleştirmeyi zorlaştırıyordu.
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("copyboard".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Otomatik başlatmada pencere GÖSTERİLMEZ: kullanıcı oturum açtığında
        // ekranına bir pano penceresi fırlamamalı, uygulama tepsiye yerleşmeli.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_FLAG]),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::core::get_history,
            commands::core::get_settings,
            commands::core::set_autostart,
            commands::core::set_clipboard_paused,
            commands::core::close_window,
            commands::core::close_current_window,
            commands::core::minimize_window,
            commands::core::toast_finished,
            commands::core::toast_resize,
            commands::core::debug_log,
            commands::core::set_language,
            commands::core::set_theme,
            commands::clipboard::copy_item,
            commands::clipboard::copy_text,
            commands::clipboard::delete_history_item,
            commands::clipboard::clear_history,
            commands::clipboard::add_to_favorites,
            commands::clipboard::remove_from_favorites,
            commands::clipboard::set_item_note,
            commands::clipboard::reorder_history,
            commands::clipboard::reorder_favorites,
            commands::clipboard::set_max_items,
            commands::clipboard::set_quickpaste_count,
            commands::shortcuts::set_shortcut,
            commands::shortcuts::set_shortcut_enabled,
            capture::take_capture_frame,
            capture::capture_retry,
            capture::snip_ready,
            capture::capture_claim_monitor,
            capture::snip_close,
            commands::capture::snip_copy_image,
            commands::capture::snip_copy_buffer,
            commands::capture::snip_copy_color,
            commands::capture::snip_save_image,
            commands::capture::snip_save_buffer,
            commands::capture::ocr_process,
            commands::capture::set_ignore_mouse_events,
            commands::gallery::get_screenshots,
            commands::gallery::copy_screenshot,
            commands::gallery::delete_screenshot,
            commands::gallery::show_screenshot_file,
            commands::gallery::open_screenshot_folder,
            commands::gallery::screenshot_context_menu,
            commands::viewer::open_screenshot_viewer,
            commands::viewer::viewer_nav,
            commands::viewer::viewer_select,
            commands::viewer::viewer_close,
            commands::viewer::viewer_minimize,
            commands::viewer::viewer_toggle_maximize,
            commands::viewer::viewer_compare_images,
            commands::viewer::viewer_copy_annotated,
            commands::widget::widget_action,
            commands::widget::set_hit_areas,
            commands::widget::set_show_widget,
            commands::widget::set_widget_transparent,
            commands::widget::set_widget_color,
            commands::widget::set_widget_opacity,
            commands::widget::set_widget_scale,
            commands::widget::quickpaste_pick,
            commands::widget::quickpaste_dismiss,
            updater::check_for_updates,
            updater::download_update,
            updater::install_update,
            commands::ready::window_ready,
            commands::record::set_video_quality,
            commands::record::set_audio_mic,
            commands::record::set_audio_mic_device,
            commands::record::list_audio_inputs,
            commands::record::get_videos,
            commands::record::delete_video,
            commands::record::open_video,
            commands::record::reveal_video,
            commands::record::set_audio_system,
            commands::record::get_audio_settings,
            commands::record::ensure_mic_permission,
            commands::record::record_start,
            commands::record::record_stop,
            commands::record::scroll_begin,
            commands::record::scroll_end,
        ])
        // Pencerelerden açılan bağlam menüleri (galeri küçük resimleri) buraya düşüyor;
        // tepsi menüsünün kendi işleyicisi ayrı.
        .on_menu_event(|app, event| {
            commands::gallery::handle_context_menu(app, event.id().as_ref());
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // ── Veri dizini ve göç ───────────────────────────────────────────
            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("veri dizini belirlenemedi: {e}"))?;
            std::fs::create_dir_all(&data_dir).ok();

            let report = migrate::migrate_from_electron(&data_dir);
            if report.performed {
                log::info!(
                    "göç: {} geçmiş, {} favori, {} ekran görüntüsü kopyalandı",
                    report.history, report.favorites, report.screenshots_copied
                );
            } else {
                log::debug!("göç atlandı: {}", report.reason);
            }

            let store = Store::load(data_dir.join("config.json"));
            migrate::sanitize(&store);
            handle.manage(AppState::new(store));
            handle.manage(capture::CaptureState::default());
            handle.manage(windows::hit_test::Registry::default());
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                handle.manage(capture::recorder::RecorderState::default());
                handle.manage(capture::scroll_stream::ScrollState::default());
            }

            // ── Uygulama kabuğu ──────────────────────────────────────────────
            // Dock simgesi yok: CopyBoard bir tepsi uygulaması.
            platform::hide_dock(&handle);

            main_window::create(&handle)?;
            tray::init(&handle)?;
            shortcuts::register_all(&handle);
            sync_autostart(&handle);

            // Widget ayarda açıksa kur.
            if handle.state::<AppState>().settings().show_widget() {
                if let Err(e) = windows::widget::create(&handle) {
                    log::error!("widget kurulamadı: {e}");
                }
            }

            // Eski sürümlerden gelen bulanık küçük resimleri arka planda yenile.
            gallery::upgrade_thumbnails(&handle);

            // Uyku / ekran kilidi: yoklamayı durdur, bekleyen yazmaları boşalt.
            platform::install_power_observers(&handle);

            // Monitör düzeni değişimlerini izle — widget ekran dışında kalmasın.
            windows::widget::start_display_watcher(&handle);

            // Hızlı yapıştır seçicisini ÖNCEDEN kur (gizli) ki ilk kısayol anında açsın.
            if let Err(e) = windows::quickpaste::create(&handle) {
                log::error!("hızlı yapıştır önceden kurulamadı: {e}");
            }

            // Paketlenmiş sürümde sessiz açılış kontrolü. Gecikmeli ki açılışla yarışmasın.
            if !tauri::is_dev() {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio_sleep(5000).await;
                    updater::check_silent(h).await;
                });
            }

            // Pano izleyicisi en sonda: pencereler ve tepsi hazır olmadan bir kopya
            // gelirse yayın gidecek yer olmaz.
            let watcher = clipboard::watcher::start(handle.clone());
            handle.manage(watcher);

            // Otomatik başlatma dışında pencereyi göster. Kısa gecikme, Electron
            // sürümündeki 300 ms ile aynı: pencere kurulumu ile ilk gösterim
            // arasına bir kare koyuyor, yoksa boş bir pencere yanıp sönüyor.
            if !std::env::args().any(|a| a == HIDDEN_FLAG) {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    let inner = h.clone();
                    let _ = h.run_on_main_thread(move || main_window::show(&inner));
                });
            }

            // Göç sessizce olmamalı: kullanıcı verisinin taşındığını görmeli, ve
            // eski sürümün verisinin DURDUĞUNU bilmeli. Pencerenin açılmasından
            // sonraya bırakılıyor — toast penceresi ilk kullanımda kuruluyor.
            if report.performed {
                let h = handle.clone();
                let (h_n, f_n, s_n) = (
                    report.history.to_string(),
                    report.favorites.to_string(),
                    report.screenshots_copied.to_string(),
                );
                let msg = i18n::t_vars(
                    &handle.state::<AppState>().store,
                    "Verileriniz aktarıldı: {history} geçmiş, {favorites} favori, {shots} ekran görüntüsü. Eski sürümün verileri olduğu yerde duruyor.",
                    &[("history", h_n.as_str()), ("favorites", f_n.as_str()), ("shots", s_n.as_str())],
                );
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    let inner = h.clone();
                    let _ = h.run_on_main_thread(move || toast::show(&inner, &msg, "success"));
                });
            }

            // Geliştirme kolaylığı: `--record-test` sabit bir bölgeyi 5 sn kaydedip
            // dosyayı raporlar — kaydetme paneline uğramadan, kayıt motorunun
            // uygulamaya entegre hâlini sınamak için.
            // `--record-test` ya da `--record-test=<kalite>[,<saniye>]` (ör. `ultra,60`).
            #[cfg(all(debug_assertions, any(target_os = "macos", target_os = "windows")))]
            if let Some(spec) = std::env::args().find_map(|a| {
                if a == "--record-test" { Some(String::new()) } else { a.strip_prefix("--record-test=").map(str::to_string) }
            }) {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    // Üçüncü parça ses kipi: `noaudio` | `sys` (varsayılan) | `mic` | `both`.
                    let mut parts = spec.split(',');
                    let quality = parts.next().filter(|q| !q.is_empty()).unwrap_or("high").to_string();
                    let secs: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(5);
                    let mode = parts.next().unwrap_or("sys");
                    let (with_mic, with_audio) = match mode {
                        "noaudio" => (false, false),
                        "mic" => (true, false),
                        "both" => (true, true),
                        _ => (false, true), // sys
                    };
                    let monitors = geom::all_monitors(&h);
                    let Some(m) = monitors.first().cloned() else {
                        // Ekran uykudayken monitör listesi BOŞ dönüyor. `exit` olmadan
                        // süreç sonsuza dek asılı kalıyordu — bir sonraki testte
                        // "takıldı" gibi görünen şey buydu.
                        println!("RECORD_TEST: monitör yok (ekran uykuda olabilir)");
                        h.exit(0);
                        return;
                    };
                    let path = std::env::temp_dir().join(format!("copyboard-record-test-{quality}-{mode}.mp4"));
                    let started = capture::recorder::start(
                        &m, 200.0, 200.0, 1280.0, 720.0, &quality,
                        with_mic, with_audio, "", "test".into(), path.clone(),
                    );
                    match started {
                        Ok(mut rec) => {
                            println!("RECORD_TEST: başladı ({quality}, {secs} sn, ses={mode})");
                            std::thread::sleep(std::time::Duration::from_secs(secs));
                            match rec.stop() {
                                Ok(p) => {
                                    let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                                    println!("RECORD_TEST: bitti {} ({:.2} MB)", p.display(), size as f64 / 1_048_576.0);
                                }
                                Err(e) => println!("RECORD_TEST: durdurma hatası: {e}"),
                            }
                        }
                        Err(e) => println!("RECORD_TEST: başlatma hatası: {e}"),
                    }
                    h.exit(0);
                });
            }

            // Geliştirme kolaylığı: `--index-video=<yol>` bir videoyu galeri indeksine
            // ekler ve çıkarılan küçük resim/süre bilgisini yazar. Kaydetme paneline
            // uğramadan indeksleme yolunu sınamak için.
            #[cfg(debug_assertions)]
            if let Some(path) = std::env::args().find_map(|a| a.strip_prefix("--index-video=").map(std::path::PathBuf::from)) {
                let h = handle.clone();
                std::thread::spawn(move || {
                    let t0 = std::time::Instant::now();
                    videos::add(&h, &path);
                    let list = videos::public_list(&h.state::<AppState>().store);
                    match list.first() {
                        Some(v) => println!(
                            "INDEX_VIDEO: ad={} süre={:.2}sn {}x{} {:.1}MB küçükresim={} bayt ({:?})",
                            v["name"].as_str().unwrap_or(""),
                            v["duration"].as_f64().unwrap_or(0.0),
                            v["w"].as_u64().unwrap_or(0),
                            v["h"].as_u64().unwrap_or(0),
                            v["bytes"].as_u64().unwrap_or(0) as f64 / 1048576.0,
                            v["thumb"].as_str().unwrap_or("").len(),
                            t0.elapsed()
                        ),
                        None => println!("INDEX_VIDEO: indekse girmedi"),
                    }
                    h.exit(0);
                });
            }

            // Ölçüm: `--shot-test` birincil monitörü 12 kez yakalar (xcap + PNG), medyanı
            // yazar ve çıkar. Release'te de çalışır — Electron'un desktopCapturer.getSources
            // + toPNG yoluyla aynı işi karşılaştırmak için (bkz. docs/PERF_WINDOWS.md).
            if std::env::args().any(|a| a == "--shot-test") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    let monitors = geom::all_monitors(&h);
                    let Some(m) = monitors.first().cloned() else {
                        println!("SHOT_TEST: monitör yok");
                        h.exit(0);
                        return;
                    };
                    let mut times: Vec<f64> = Vec::new();
                    let (mut bytes, mut dims) = (0usize, (0u32, 0u32));
                    for _ in 0..12 {
                        let t = std::time::Instant::now();
                        if let Some(f) = capture::screenshot::capture_monitor(&m, 0) {
                            times.push(t.elapsed().as_secs_f64() * 1000.0);
                            bytes = f.png.len();
                            dims = (f.width, f.height);
                        }
                    }
                    let mut sorted = times.clone();
                    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    let med = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
                    println!(
                        "SHOT_TEST {}x{}: yakalama+PNG medyan {:.1} ms (ilk {:.1}), PNG {} KB",
                        dims.0, dims.1, med, times.first().copied().unwrap_or(0.0), bytes / 1024
                    );
                    println!("  turlar (ms): {}", times.iter().map(|t| format!("{t:.0}")).collect::<Vec<_>>().join(", "));
                    h.exit(0);
                });
            }

            // Geliştirme kolaylığı: `--set-lang=en` — dil değişiminin GERÇEKTEN
            // uygulanıp uygulanmadığını sınamak için.
            #[cfg(debug_assertions)]
            if let Some(lang) = std::env::args().find_map(|a| a.strip_prefix("--set-lang=").map(str::to_string)) {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    let inner = h.clone();
                    let _ = h.run_on_main_thread(move || {
                        commands::core::apply_language(&inner, &lang);
                    });
                });
            }

            // Hata ayıklama derlemesinde ana thread bekçisi: kilitlenmeyi loga yazar.
            #[cfg(debug_assertions)]
            dbgtrace::start(handle.clone());

            // Geliştirme kolaylığı: `--qa` — Rust tarafındaki kullanıcı akışlarını
            // sırayla çalıştırıp sonuçlarını günlüğe yazan kendini-sınama (bkz. `qa.rs`).
            #[cfg(debug_assertions)]
            if std::env::args().any(|a| a == "--qa") {
                qa::run(handle.clone());
            }

            // Geliştirme kolaylığı: `--copy-test=metin` — listeden kopyalamanın
            // (`copy_text` komutu) panoya GERÇEKTEN yazıp yazmadığını, geri okuyarak
            // sınar. Windows'ta "kopyalandı diyor ama yapıştırınca eski içerik geliyor"
            // raporunu yeniden üretmek için eklendi.
            #[cfg(debug_assertions)]
            if let Some(text) = std::env::args().find_map(|a| a.strip_prefix("--copy-test=").map(str::to_string)) {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2000));
                    let inner = h.clone();
                    let t = text.clone();
                    let _ = h.run_on_main_thread(move || {
                        let before = platform::clipboard_read_text();
                        // `copy_text` komutu async; senkron gövdesi `write_and_record`.
                        commands::clipboard::write_and_record(&inner, &t);
                        let after = platform::clipboard_read_text();
                        log::info!(
                            "COPY_TEST: yazılan={t:?} · önce={before:?} · hemen sonra={after:?}"
                        );
                    });
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let later = platform::clipboard_read_text();
                    log::info!("COPY_TEST: 1,5 sn sonra pano={later:?}");
                });
            }

            // Geliştirme kolaylığı: `--viewer` galerinin ilk kaydını görüntüleyicide açar.
            #[cfg(debug_assertions)]
            if std::env::args().any(|a| a == "--viewer") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    let inner = h.clone();
                    let _ = h.run_on_main_thread(move || {
                        let list = gallery::public_list(&inner.state::<AppState>().store);
                        if let Some(id) = list.first().and_then(|s| s.get("id")).and_then(|i| i.as_str()) {
                            commands::viewer::open(&inner, id);
                        } else {
                            log::warn!("galeri boş — görüntüleyici açılamadı");
                        }
                    });
                });
            }

            // Geliştirme kolaylığı: `--capture=draw` ile yakalamayı elle tetikle.
            // Yalnız debug build'de — kısayola basmadan overlay'i sınamanın tek yolu.
            #[cfg(debug_assertions)]
            if let Some(mode) = std::env::args()
                .find_map(|a| a.strip_prefix("--capture=").map(str::to_string))
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    let inner = h.clone();
                    let _ = h.run_on_main_thread(move || capture::start(&inner, &mode));
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("CopyBoard başlatılamadı")
        .run(|app, event| {
            // `ExitRequested` VE `Exit` — ilki bir dinleyici tarafından iptal edilebiliyor
            // ve her çıkış yolunda tetiklenmiyor; `Exit` son sözü söylüyor. İkisi de
            // idempotent (`stop`/`flush` iki kez çağrılabilir).
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(w) = app.try_state::<clipboard::watcher::Watcher>() {
                    w.stop();
                }
                #[cfg(target_os = "macos")]
                platform::macos::hotkey_carbon::unregister_all();
                // Debounce penceresi içindeki son yazmayı diske indir — çıkışta
                // kaybolacak tek şey en yeni pano kaydı olurdu.
                if let Some(state) = app.try_state::<AppState>() {
                    state.store.flush();
                }
            }
        });
}

/// Panik hâlinde sessizce ölmek yerine kullanıcıya söyle. Electron sürümündeki
/// `process.on('uncaughtException')` + `dialog.showErrorBox` karşılığı.
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "bilinmeyen hata".into());
        let where_ = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        eprintln!("[CopyBoard] BEKLENMEYEN HATA: {msg} ({where_})");
        default(info);
    }));
}

/// `std::thread::sleep`'in async karşılığı — Tauri'nin runtime'ını bloklamadan bekler.
async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms))
    })
    .await;
}

/// Kayıtlı `autoStart` ayarını işletim sistemine yansıtır. Ayar ile gerçek durum
/// birbirinden kayabilir (kullanıcı OS tarafından kaldırmış olabilir, ya da uygulama
/// bir kez paketlenmemiş çalışmıştır), bu yüzden her açılışta eşitleniyor.
fn sync_autostart(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    // Yalnız paketlenmiş uygulama (Electron `app.isPackaged`): `tauri dev`,
    // geliştiricinin makinesine `target/debug/copyboard --hidden`i oturum açılış
    // öğesi olarak yazıyordu.
    if tauri::is_dev() {
        return;
    }
    let want = app.state::<AppState>().settings().auto_start();
    let mgr = app.autolaunch();
    let have = mgr.is_enabled().unwrap_or(false);
    // İstenen AÇIK ise `enable()` her açılışta yeniden yazılıyor, "zaten açık" olsa
    // bile: macOS LaunchAgent plist'i MUTLAK yolu saklıyor ve `is_enabled()` yalnız
    // dosyanın varlığına bakıyor. Uygulama İndirilenler'den /Applications'a taşınınca
    // eski kayıt silinmiş bir binary'yi gösterip kalıyordu. Electron
    // `setLoginItemSettings`i her paketli açılışta yeniden uyguluyordu.
    if !want && !have {
        return;
    }
    let result = if want { mgr.enable() } else { mgr.disable() };
    if let Err(e) = result {
        log::warn!("otomatik başlatma ayarlanamadı: {e}");
    }
}

/// Toast'u herhangi bir yerden göstermek için kısayol.
pub fn show_toast(app: &tauri::AppHandle, message: &str, kind: &str) {
    toast::show(app, message, kind);
}
