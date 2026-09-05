//! Video kaydı ve kaydırmalı yakalama komutları.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;
// Kaydetme paneli ve Escape işleyicisi yalnız kayıt/kaydırma olan platformlarda
// (macOS: ScreenCaptureKit, Windows: Windows.Graphics.Capture) kullanılıyor.
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_dialog::DialogExt;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

use crate::state::AppState;

// ── Ses ve kalite ayarları ───────────────────────────────────────────────────

#[tauri::command]
pub fn set_video_quality(app: tauri::AppHandle, value: String) {
    app.state::<AppState>().settings().set_video_quality(value);
}

/// Kullanılabilir ses giriş aygıtları.
#[tauri::command]
pub fn list_audio_inputs() -> Vec<serde_json::Value> {
    crate::platform::audio_inputs()
}

/// Mikrofon aygıtını seçer. Boş dizge = sistem varsayılanını izle.
#[tauri::command]
pub fn set_audio_mic_device(app: tauri::AppHandle, value: String) {
    app.state::<AppState>().settings().set_audio_mic_device(value);
}

#[tauri::command]
pub fn set_audio_mic(app: tauri::AppHandle, value: bool) {
    app.state::<AppState>().settings().set_audio_mic(value);
}

#[tauri::command]
pub fn set_audio_system(app: tauri::AppHandle, value: bool) {
    app.state::<AppState>().settings().set_audio_system(value);
}

#[tauri::command]
pub fn get_audio_settings(app: tauri::AppHandle) -> serde_json::Value {
    let s = app.state::<AppState>();
    let set = s.settings();
    serde_json::json!({ "mic": set.audio_mic(), "system": set.audio_system() })
}

/// macOS'ta mikrofon TCC ile korunuyor. Kaydı başlatmadan ÖNCE sorulur ki bir ret,
/// sessiz bir başarısızlık yerine anlaşılır bir mesaj olarak çıksın.
#[tauri::command]
pub fn ensure_mic_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        // ScreenCaptureKit mikrofonu kendi isteğiyle açıyor; burada yalnız kullanıcıya
        // ne olacağını haber veriyoruz. Gerçek istem ilk kayıtta sistemden geliyor.
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

// ── Video kaydı ──────────────────────────────────────────────────────────────

/// Seçilen bölgenin kaydını başlatır. `rect` FİZİKSEL piksel.
#[tauri::command]
pub async fn record_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (x, y, width, height, &window);
        crate::windows::toast::show(&app, "Video kaydı bu platformda henüz taşınmadı.", "error");
        return Err("desteklenmiyor".into());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let label = window.label().to_string();
        let index = label.rsplit('-').next().and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
        let monitors = crate::geom::all_monitors(&app);
        let monitor = monitors.get(index).ok_or("monitör bulunamadı")?.clone();

        // Ayarlar okunup KOPYALANIYOR: `settings()` geçici bir `State` guard'ına
        // bağlı ve borç, kayıt başlatma çağrısı boyunca yaşayamaz.
        let state = app.state::<AppState>();
        let settings = state.settings();
        let (quality, mic, system) = (settings.video_quality(), settings.audio_mic(), settings.audio_system());
        let mic_device = settings.audio_mic_device();
        let path = std::env::temp_dir().join(format!(
            "copyboard_kayit_{}.mp4",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));

        // Motor kurulumu (ses aygıtları + kodlayıcı) bazı makinelerde saniyeler sürüyor;
        // ne kadar sürdüğü ölçülebilsin.
        let t_start = std::time::Instant::now();
        let recording = crate::capture::recorder::start(
            &monitor, x, y, width, height,
            &quality,
            mic,
            system,
            &mic_device,
            label.clone(),
            path,
        )
        .map_err(|e| {
            crate::windows::toast::show(&app, &format!("Kayıt başlatılamadı: {e}"), "error");
            e
        })?;

        log::info!("kayıt motoru hazır (+{} ms)", t_start.elapsed().as_millis());
        // Kayıt bir monitörde başladı — DİĞER monitörlerin overlay'leri gitsin.
        crate::capture::close_all_except(&app, &label);
        *app.state::<crate::capture::recorder::RecorderState>().0.lock().unwrap() = Some(recording);
        Ok(())
    }
}

/// Kaydı durdurur, kullanıcıya nereye kaydedeceğini sorar.
///
/// `async`: `Recording::stop()` mux'un dosyayı kapatmasını 5 sn'ye kadar yoklayarak
/// bekliyor. Senkron komut ana thread'de koştuğu için bu süre boyunca tüm pencereler,
/// toast ve tepsi donuyordu. Electron'da aynı iş asenkrondu (`endVideoStream` geri
/// çağrısı + `await showSaveDialog`).
#[tauri::command]
pub async fn record_stop(app: tauri::AppHandle) {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = &app;
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let taken = app
            .state::<crate::capture::recorder::RecorderState>()
            .0
            .lock()
            .unwrap()
            .take();
        let Some(mut recording) = taken else { return };
        let label = recording.window_label.clone();

        // ── Panelin GÖRÜNDÜĞÜ yer ────────────────────────────────────────────────
        // İlk hâli overlay'i gizliyordu ("panelin önünü kapatmasın") ve panele parent
        // VERMİYORDU. Sahipsiz bir kaydetme paneli Windows'ta öndeki pencereye/BİRİNCİL
        // monitöre göre konumlanır: üç monitörlü kurulumda kullanıcı ortadaki ekranda
        // kaydı durduruyor, panel başka ekranda açılıyor ve "panel hiç gelmedi" olarak
        // görülüyordu (A14). Ekran görüntüsü kaydetme yolu (`capture::save_png`) bunu
        // zaten doğru yapıyor: overlay'i GİZLEME, yalnız her-zaman-üstte'yi indir ve
        // paneli ona parent'la — panel o monitörde, overlay'in üstünde açılır.
        let overlay = app.get_webview_window(&label);
        if let Some(w) = &overlay {
            let _ = w.set_always_on_top(false);
        }

        // ── Durdurma uzarsa kullanıcı BEKLEMESİN, kayıt da KAYBOLMASIN ───────────
        // `Recording::stop()` üç bloklayıcı aşama: yakalamayı kapat, sesi kapat, mux'u
        // tamamla. Sonuncusu donanım kodlayıcısını boşaltıyor ve bazı makinelerde çok
        // uzun sürüyor. Eskiden burada `await` ediliyordu: panel açılmıyor, oturum
        // kapanmıyor ve kullanıcı yeni yakalama başlatamıyordu ("İşlem devam ediyor").
        //
        // Artık durdurma kendi thread'inde: 12 sn'de bitmezse oturum BIRAKILIYOR
        // (overlay'ler kapanır, uygulama serbest) ve iş arka planda sürüyor. Bittiğinde
        // panel yerine dosya doğrudan Videolar'a alınıp yolu söyleniyor — kayıt her
        // hâlükârda elde kalıyor.
        let stop_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let released = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let done = stop_done.clone();
            let released = released.clone();
            let h = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(12));
                if done.load(Ordering::Acquire) {
                    return;
                }
                released.store(true, Ordering::Release);
                // Hangi ADIMDA olduğumuzu da söyle: üç adımın nedeni ve çözümü farklı.
                let phase = crate::capture::stop_phase_name();
                log::warn!("durdurma 12 sn'yi geçti (aşama: {phase}) — oturum bırakılıyor, hazırlama arka planda sürüyor");
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || {
                    crate::windows::toast::show(
                        &h2,
                        &format!("Video hazırlanıyor ({phase})… Bitince nereye kaydedildiğini bildireceğim."),
                        "info",
                    );
                    crate::capture::close_all(&h2, None);
                });
            });
        }

        let worker_app = app.clone();
        let worker_label = label.clone();
        let worker_overlay = overlay.clone();
        let spawned = std::thread::Builder::new()
            .name("copyboard-record-stop".into())
            .spawn(move || {
                let result = recording.stop();
                stop_done.store(true, Ordering::Release);
                let temp = match result {
                    Ok(p) => p,
                    Err(e) => {
                        // Günlüğe de yaz: toast imlecin bulunduğu monitörde çıkıyor,
                        // gözden kaçarsa geriye hiç iz kalmıyordu.
                        log::error!("kayıt durdurulamadı: {e}");
                        // Sonlandırma (mux) düştüyse suçlu büyük olasılıkla GPU kodlayıcısı:
                        // bundan sonraki kayıtlar yazılım kodlayıcısıyla yapılsın.
                        #[cfg(target_os = "windows")]
                        let fell_back = if e.contains("sonlandırılamadı")
                            && crate::capture::recorder::hardware_encoder()
                        {
                            crate::capture::recorder::set_hardware_encoder(false);
                            log::warn!("donanım kodlayıcısı sonlandırmada takıldı — bundan sonra yazılım kodlayıcısı");
                            true
                        } else {
                            false
                        };
                        #[cfg(not(target_os = "windows"))]
                        let fell_back = false;
                        let msg = if fell_back {
                            "Donanım video kodlayıcısı yanıt vermedi. Sonraki kayıtlar yazılım kodlayıcısıyla yapılacak.".to_string()
                        } else {
                            format!("Hata: Video verisi alınamadı ({e})")
                        };
                        let h = worker_app.clone();
                        let _ = worker_app.run_on_main_thread(move || {
                            crate::windows::toast::show(&h, &msg, "error");
                            crate::capture::close_all(&h, None);
                        });
                        return;
                    }
                };
                if released.load(Ordering::Acquire) {
                    save_without_dialog(&worker_app, temp);
                } else {
                    open_save_dialog(&worker_app, &worker_label, worker_overlay, temp);
                }
            });
        if let Err(e) = spawned {
            log::error!("durdurma thread'i başlatılamadı: {e}");
            crate::windows::toast::show(&app, "Hata: Kayıt durdurulamadı", "error");
            crate::capture::close_all(&app, None);
        }
    }
}

/// Kaydetme paneli olmadan bitir: oturum çoktan bırakıldığı için paneli sahiplenecek
/// pencere yok. Kayıt KAYBOLMASIN — Videolar klasörüne alınıp yolu söyleniyor.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn save_without_dialog(app: &tauri::AppHandle, temp: std::path::PathBuf) {
    let name = temp.file_name().map(|n| n.to_os_string());
    let dest = app
        .path()
        .video_dir()
        .ok()
        .filter(|d| d.is_dir())
        .zip(name)
        .map(|(dir, n)| dir.join(n));
    let final_path = match dest {
        Some(d) => match std::fs::copy(&temp, &d) {
            Ok(_) => {
                let _ = std::fs::remove_file(&temp);
                d
            }
            Err(e) => {
                log::warn!("video Videolar klasörüne alınamadı ({e}) — geçici konumda kalıyor");
                temp
            }
        },
        None => temp,
    };
    let p = final_path.to_string_lossy().to_string();
    log::info!("video (panel olmadan) kaydedildi: {p}");
    crate::platform::clipboard_write_text(&p);
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::clipboard::history::add(&h, &p);
        crate::windows::toast::show(&h, "Video kaydedildi. Dosya yolu panoya kopyalandı.", "success");
    });
}

/// Kaydetme panelini açar ve sonucunu işler.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn open_save_dialog(
    app: &tauri::AppHandle,
    label: &str,
    overlay: Option<tauri::WebviewWindow>,
    temp: std::path::PathBuf,
) {
    let app = app.clone();
    {
        let default_name = temp
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "kayit.mp4".into());
        let videos = app.path().video_dir().ok();
        let handle = app.clone();

        let mut builder = app.dialog().file()
            .set_title("Videoyu Kaydet")
            .set_file_name(&default_name)
            .add_filter("Videos", &["mp4", "mov"]);
        // Var olmayan bir başlangıç dizini (yönlendirilmiş/senkronize Videolar klasörü)
        // panelin hiç açılmamasına yol açabiliyor — yoksa hiç verme.
        if let Some(dir) = videos.filter(|d| d.is_dir()) {
            builder = builder.set_directory(dir);
        }
        if let Some(w) = &overlay {
            // Sahip pencereyi panele HAZIRLA. Kayıt boyunca overlay tıklama-geçirgen
            // (`WS_EX_TRANSPARENT`) ve her zaman üstte kalıyor; ayrıca kullanıcı bir
            // dakika boyunca başka uygulamalarla çalıştığı için sürecimiz artık ön
            // planda olmayabiliyor. Windows ön planda olmayan bir sürecin penceresini
            // öne çıkarmaz: panel açılsa bile arkada kalır ve "hiç gelmedi" görünür.
            crate::windows::hit_test::clear(&app, &label);
            let _ = w.set_ignore_cursor_events(false);
            let _ = w.set_always_on_top(false);
            let _ = w.set_focus();
            builder = builder.set_parent(w);
        }
        log::info!(
            "kaydetme paneli açılıyor: {default_name} (sahip pencere: {})",
            if overlay.is_some() { label } else { "yok" }
        );
        // Kaydedicideki yazı SİLİNMİYOR, değişiyor.
        //
        // Önce siliniyordu ve panel açılana kadar ekranda hiçbir şey kalmıyordu.
        // Panelin belirmesi (NSSavePanel'in ilk açılışı) gözle görülür sürebiliyor;
        // o boşlukta kullanıcı "durdura bastım, bir şey olmadı" deyip tekrar basıyor.
        // Artık yazı "kaydetme penceresi açılıyor" olarak kalıyor ve overlay ancak
        // panel sonuçlanınca kapanıyor — ekran hiçbir an boş kalmıyor.
        crate::windows::emit_to(&app, &label, "record-save-ready", ());

        // ── Panel AÇILAMAZSA kayıt kaybolmasın ───────────────────────────────────
        // Panel açılmadığında geri çağrı hiç gelmiyor ve kullanıcı bir dakikalık kaydını
        // kaybetmiş sayıyor. Bekçi 8 sn sonra bakıyor: sürecimize ait görünür bir kabuk
        // iletişim kutusu VARSA panel açık demektir (kullanıcı klasör seçiyor olabilir) —
        // susuyor. Yoksa yolu panoya koyup söylüyor ve günlüğe yazıyor.
        let settled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(target_os = "windows")]
        {
            let settled = settled.clone();
            let watchdog_app = app.clone();
            let watchdog_path = temp.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                if settled.load(Ordering::Acquire) {
                    return;
                }
                if let Some(hwnd) = crate::platform::windows::find_open_file_dialog() {
                    // Panel VAR ama kullanıcı göremiyor olabilir — nerede olduğunu yaz.
                    log::warn!(
                        "bekçi: kaydetme paneli açık (hwnd={hwnd:#x}, dikdörtgen={:?}), bekleniyor",
                        crate::platform::windows::window_rect(hwnd)
                    );
                    return;
                }
                if settled.swap(true, Ordering::AcqRel) {
                    return;
                }
                let p = watchdog_path.to_string_lossy().to_string();
                log::error!(
                    "kaydetme paneli açılamadı (8 sn, görünür pencereler: {:?}) — kayıt: {p}",
                    crate::platform::windows::visible_window_titles()
                );
                crate::platform::clipboard_write_text(&p);
                let h = watchdog_app.clone();
                let _ = watchdog_app.run_on_main_thread(move || {
                    crate::clipboard::history::add(&h, &p);
                    crate::windows::toast::show(
                        &h,
                        "Kaydetme penceresi açılmadı. Video geçici klasörde, yolu panoya kopyalandı.",
                        "warning",
                    );
                    crate::capture::close_all(&h, None);
                });
            });
        }

        // Panelin istenmesiyle sonuçlanması arasındaki süre. Kullanıcının düşünme
        // süresini de içeriyor ama "panel hiç açılmadı" ile "geç açıldı"yı ayırıyor.
        let t_dialog = std::time::Instant::now();
        builder.save_file(move |chosen| {
            log::info!("kaydetme paneli sonuçlandı ({:?})", t_dialog.elapsed());
            // Bekçi zaten devreye girdiyse (panel çok geç yanıt verdi) tekrar toast atma.
            let already = settled.swap(true, Ordering::AcqRel);
            if already {
                log::warn!("kaydetme paneli geç yanıt verdi — bekçi zaten devreye girmişti");
                if let Some(dest) = chosen.and_then(|p| p.into_path().ok()) {
                    if std::fs::copy(&temp, &dest).is_ok() {
                        let _ = std::fs::remove_file(&temp);
                        log::info!("video kaydedildi (geç): {}", dest.display());
                    }
                }
                return;
            }
            match chosen.and_then(|p| p.into_path().ok()) {
                Some(dest) => match std::fs::copy(&temp, &dest) {
                    Ok(_) => {
                        let _ = std::fs::remove_file(&temp);
                        log::info!("video kaydedildi: {}", dest.display());
                        crate::windows::toast::show(&handle, "Video Kaydedildi.", "success");
                    }
                    Err(e) => {
                        log::error!("video kopyalanamadı ({}): {e}", dest.display());
                        crate::windows::toast::show(&handle, &format!("Kaydetme Hatası: {e}"), "error")
                    }
                },
                None => {
                    // İptal: kayıt KAYBOLMASIN — geçici dosyanın yolu panoya gitsin.
                    // (Panel hiç açılamadığında da buraya düşüyoruz; günlük ikisini
                    // ayırt etmeye yarayan tek iz, o yüzden yazılıyor.)
                    log::info!("kaydetme paneli kapandı (seçim yok) — geçici dosya panoya");
                    let p = temp.to_string_lossy().to_string();
                    crate::platform::clipboard_write_text(&p);
                    crate::clipboard::history::add(&handle, &p);
                    crate::windows::toast::show(
                        &handle,
                        "Kayıt iptal edildi. Dosya yolu panoya kopyalandı.",
                        "info",
                    );
                }
            }
            crate::capture::close_all(&handle, None);
        });
    }
}

// ── Kaydırmalı yakalama ──────────────────────────────────────────────────────

use std::sync::atomic::{AtomicBool, Ordering};

/// Escape'i şu an kaydırma evresi mi tutuyor? Hızlı Yapıştır seçicisi de aynı tuşu
/// kaydettiği için sahiplik izleniyor.
static SCROLL_OWNS_ESCAPE: AtomicBool = AtomicBool::new(false);

fn escape_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// Kaydırma evresi başlıyor.
///
/// Kaydırma başladıktan sonra overlay fare olaylarını almayı bırakıyor (kullanıcı
/// altındaki uygulamayı kaydırabilsin diye) ve o uygulamaya yapılan ilk tıklama klavye
/// odağını da götürüyor — Escape penceremizin erişemeyeceği bir yere gidiyor. Bu yüzden
/// Escape TAM OLARAK kaydırma evresi boyunca global olarak kaydediliyor. İnvaziv
/// (Escape öndeki uygulamaya ait), o yüzden evreden çıkan her yol onu bırakıyor.
#[tauri::command]
pub async fn scroll_begin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (x, y, width, height, channel, &window);
        crate::windows::toast::show(&app, "Kaydırmalı yakalama bu platformda henüz taşınmadı.", "error");
        return Err("desteklenmiyor".into());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let label = window.label().to_string();
        let index = label.rsplit('-').next().and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
        let monitors = crate::geom::all_monitors(&app);
        let monitor = monitors.get(index).ok_or("monitör bulunamadı")?.clone();

        // Kaydırmalı yakalama tek monitörde tek pencereyi izliyor; diğer monitörlerin
        // overlay'leri yalnızca yolda duran karartılmış camlar olurdu.
        crate::capture::close_all_except(&app, &label);

        let stream = crate::capture::scroll_stream::start(
            &monitor, x, y, width, height, 15, Some("CopyBoard"), channel,
        )
        .map_err(|e| {
            crate::windows::toast::show(&app, &format!("Ekran akışı başlatılamadı: {e}"), "error");
            e
        })?;

        *app.state::<crate::capture::scroll_stream::ScrollState>().0.lock().unwrap() = Some(stream);

        let handle = app.clone();
        // Kaydolamazsa ölümcül değil: overlay'in kendi Escape'i odağı varken hâlâ
        // çalışıyor, araç çubuğundaki iptal düğmesi de her zaman.
        // Seçici de Escape'i tutuyor olabilir; kaydırma evresi boyunca sahiplik bizde.
        let _ = app.global_shortcut().unregister(escape_shortcut());
        SCROLL_OWNS_ESCAPE.store(true, Ordering::Release);
        let _ = app.global_shortcut().on_shortcut(escape_shortcut(), move |_a, _s, e| {
            if e.state == ShortcutState::Pressed {
                // `close_all` → `teardown_streams` Escape'i kaldırıyor; işleyici içinde
                // yapılırsa eklentinin kilidi ikinci kez alınır (bkz. `shortcuts::defer_to_main`).
                crate::shortcuts::defer_to_main(&handle, |h| crate::capture::close_all(h, None));
            }
        });
        Ok(())
    }
}

#[tauri::command]
pub async fn scroll_end(app: tauri::AppHandle) {
    teardown_streams(&app);
}

/// Kaydırma/kayıt akışlarını ve kaydırma evresinin global Escape'ini bırakır.
///
/// `capture::finish()` de bunu çağırıyor, böylece evreden çıkan HER yol (bitiş, iptal,
/// ESC, pencere yok oldu, hata) aynı temizliği yapıyor — Electron'un `win.once('closed',
/// releaseScrollEscape)` garantisinin karşılığı.
///
/// Escape SAHİPLİK kontrolüyle bırakılıyor: Hızlı Yapıştır seçicisi de Escape'i
/// kaydediyor ve koşulsuz `unregister` onun kaydını çalıyordu — seçici açıkken bir
/// kaydırma yakalaması bitince Esc ile kapanma sessizce ölüyordu.
pub fn teardown_streams(app: &tauri::AppHandle) {
    let owned = SCROLL_OWNS_ESCAPE.swap(false, Ordering::AcqRel);
    if owned {
        let _ = app.global_shortcut().unregister(escape_shortcut());
        // Seçici hâlâ açıksa Escape'i ona geri ver.
        crate::windows::quickpaste::rearm_escape_if_visible(app);
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Some(mut s) = app
            .state::<crate::capture::scroll_stream::ScrollState>()
            .0
            .lock()
            .unwrap()
            .take()
        {
            s.stop();
        }
        if let Some(mut r) = app
            .state::<crate::capture::recorder::RecorderState>()
            .0
            .lock()
            .unwrap()
            .take()
        {
            // Kayıt yarıda kaldı: dosyayı kapatıp bırak. Kullanıcı kaydetme panelini
            // görmediği için yolu da söylemiyoruz; geçici dosya sistemin temizliğine kalır.
            let _ = r.stop();
        }
    }
}
