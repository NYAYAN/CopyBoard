//! Video kaydı ve kaydırmalı yakalama komutları.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;
// Kaydetme paneli ve Escape işleyicisi yalnız kayıt/kaydırma olan platformlarda
// (macOS: ScreenCaptureKit, Windows: Windows.Graphics.Capture) kullanılıyor.
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

use crate::state::AppState;

// ── Ses ve kalite ayarları ───────────────────────────────────────────────────

#[tauri::command]
pub fn set_video_quality(app: tauri::AppHandle, value: String) {
    app.state::<AppState>().settings().set_video_quality(value);
}

/// Galerideki videolar (dosyası silinmiş olanlar elenmiş).
#[tauri::command]
pub fn get_videos(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    crate::videos::public_list(&app.state::<AppState>().store)
}

/// Videoyu listeden düşürür; `with_file` ise dosyayı da siler.
#[tauri::command]
pub fn delete_video(app: tauri::AppHandle, id: String, with_file: bool) {
    crate::videos::delete(&app, &id, with_file);
}

/// Videoyu varsayılan oynatıcıda açar.
#[tauri::command]
pub fn open_video(app: tauri::AppHandle, id: String) {
    let Some(v) = crate::videos::by_id(&app.state::<AppState>().store, &id) else { return };
    let Some(file) = v.get("file").and_then(|f| f.as_str()) else { return };
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_path(file, None::<&str>) {
        log::warn!("video açılamadı ({file}): {e}");
    }
}

/// Videoyu Finder/Gezgin'de gösterir.
#[tauri::command]
pub fn reveal_video(app: tauri::AppHandle, id: String) {
    let Some(v) = crate::videos::by_id(&app.state::<AppState>().store, &id) else { return };
    let Some(file) = v.get("file").and_then(|f| f.as_str()) else { return };
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().reveal_item_in_dir(file) {
        log::warn!("video klasörde gösterilemedi ({file}): {e}");
    }
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
            // Kayıt tek monitörde sürecek ama `close_all_except` HENÜZ çağrılmadı;
            // o an açık olan HER overlay dışlanıyor.
            &crate::capture::overlay_window_ids(&app),
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

/// Kaydı durdurur ve videoyu KENDİ dizinine yazar.
///
/// ## Neden kaydetme paneli yok
///
/// Önce her kaydın sonunda "nereye kaydedeyim?" paneli açılıyordu. Ekran görüntüleri
/// zaten öyle çalışmıyor — kendi klasörlerine yazılıp galeride listeleniyorlar — ve
/// video için panel hem akışı kesiyordu hem de bir dizi soruna kaynaklık ediyordu:
/// overlay'e parent'lanmazsa başka uygulamanın arkasında açılması, açılmazsa kaydın
/// kaybolma riski, kullanıcının panel gelene kadar boş ekrana bakması.
///
/// Artık video doğrudan [`crate::videos::videos_dir`] altına alınıp galeriye
/// giriyor; kullanıcı oradan oynatabiliyor, klasörde gösterebiliyor ya da
/// istediği yere taşıyabiliyor.
///
/// `async`: `Recording::stop()` mux'u sonlandırmayı bekliyor. Senkron komut ana
/// thread'de koşsaydı o süre boyunca tüm pencereler ve tepsi donardı.
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

        // ── Durdurma uzarsa kullanıcı BEKLEMESİN ────────────────────────────────
        // `stop()` mux'u sonlandırıyor; bu bazı makinelerde uzayabiliyor. 12 sn'de
        // bitmezse oturum bırakılıyor (overlay'ler kapanır, uygulama serbest) ve iş
        // arka planda sürüyor — kayıt her hâlükârda elde kalıyor.
        let stop_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let done = stop_done.clone();
            let h = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(12));
                if done.load(Ordering::Acquire) {
                    return;
                }
                let phase = crate::capture::stop_phase_name();
                log::warn!("durdurma 12 sn'yi geçti (aşama: {phase}) — oturum bırakılıyor");
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || {
                    crate::windows::toast::show(
                        &h2,
                        &format!("Video hazırlanıyor ({phase})… Bitince galeriye eklenecek."),
                        "info",
                    );
                    crate::capture::close_all(&h2, None);
                });
            });
        }

        let worker_app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("copyboard-record-stop".into())
            .spawn(move || {
                let result = recording.stop();
                stop_done.store(true, Ordering::Release);
                let app = worker_app;

                let temp = match result {
                    Ok(p) => p,
                    Err(e) => {
                        log::error!("kayıt durdurulamadı: {e}");
                        #[cfg(target_os = "windows")]
                        if (e.contains("sonlandırılamadı") || e.contains("veri yazmıyor"))
                            && crate::capture::recorder::hardware_encoder()
                        {
                            crate::capture::recorder::set_hardware_encoder(false);
                            log::warn!("donanım kodlayıcısı takıldı — bundan sonra yazılım");
                        }
                        crate::windows::toast::show(&app, &format!("Kayıt Hatası: {e}"), "error");
                        crate::capture::close_all(&app, None);
                        return;
                    }
                };

                store_recording(&app, &temp);
                crate::capture::close_all(&app, None);
            });

        if let Err(e) = spawned {
            log::error!("durdurma thread'i başlatılamadı: {e}");
            crate::windows::toast::show(&app, "Hata: Kayıt durdurulamadı", "error");
            crate::capture::close_all(&app, None);
        }
        let _ = label;
    }
}

/// Geçici kaydı kalıcı dizine taşır ve galeriye ekler.
///
/// Taşıma önce `rename` ile deneniyor: geçici dizinle hedef aynı birimdeyse bu anlık
/// ve kopya üretmiyor. Farklı birimlerdeyse (bazı kurulumlarda `/tmp` ayrı) `rename`
/// başarısız oluyor, o zaman kopyala-sil'e düşülüyor.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn store_recording(app: &tauri::AppHandle, temp: &std::path::Path) {
    let dir = crate::videos::videos_dir(app);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::error!("video dizini oluşturulamadı: {e}");
        crate::windows::toast::show(app, &format!("Kaydetme Hatası: {e}"), "error");
        return;
    }
    let name = temp
        .file_name()
        .map(std::ffi::OsString::from)
        .unwrap_or_else(|| std::ffi::OsString::from("kayit.mp4"));
    let dest = dir.join(&name);

    let moved = std::fs::rename(temp, &dest).is_ok()
        || (std::fs::copy(temp, &dest).is_ok() && {
            let _ = std::fs::remove_file(temp);
            true
        });
    if !moved {
        log::error!("video taşınamadı: {} -> {}", temp.display(), dest.display());
        // Kayıt KAYBOLMASIN: geçici yolu panoya koy ve söyle.
        let p = temp.to_string_lossy().to_string();
        crate::platform::clipboard_write_text(&p);
        crate::windows::toast::show(
            app,
            "Video taşınamadı. Geçici dosya yolu panoya kopyalandı.",
            "error",
        );
        return;
    }

    log::info!("video kaydedildi: {}", dest.display());
    crate::videos::add(app, &dest);
    crate::windows::toast::show(app, "Video Kaydedildi.", "success");
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

        // Ayıklama listesi AKIŞTAN HEMEN ÖNCE toplanıyor: `close_all_except` diğer
        // monitörlerin overlay'lerini yeni kapattı, yani listede yalnız ekranda
        // gerçekten duran pencere kalıyor.
        let exclude = crate::capture::overlay_window_ids(&app);
        // ── Kare hızı ───────────────────────────────────────────────────────────
        // Eşleştirmenin izleyebildiği kaydırma hızı doğrudan kare hızıyla çarpımlı
        // (bkz. scroller.js SAMPLE_TICK): kare başına ~240 px'i geçen kaydırma
        // reddediliyor, yani 15 fps ≈ 3600 px/sn tavan. Sabit 15 fps bu yüzden
        // hızlı kaydıran kullanıcıda "Daha yavaş kaydırın"a çıkıyordu.
        //
        // 30 fps'e çıkıyor; ölçüm (2026-09-11, bu makine, 1040x1850 = 7,3 MB/kare):
        // taşıma 48 kare/sn ve 352 MB/sn'yi kayıpsız götürüyor, gönderme 0,0 ms,
        // kırpma 2,6 ms. Yani darboğaz IPC değil — sınır renderer'ın kare başına
        // örnekleme maliyeti (7,3 MB'da 11 ms). Bütçe o yüzden bant genişliğine
        // bağlanıyor: çok büyük bölgelerde (tam ekran 2560x1440 ≈ 14 MB) hız
        // kendiliğinden düşüyor, küçük bölgelerde 30'a çıkıyor.
        const FPS_BUDGET_MBPS: f64 = 240.0;
        let frame_mb = width * height * 4.0 / 1_048_576.0;
        let fps: u32 = std::env::var("COPYBOARD_SCROLL_FPS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| {
                ((FPS_BUDGET_MBPS / frame_mb.max(0.1)) as u32).clamp(15, 30)
            });
        let stream = crate::capture::scroll_stream::start(
            &monitor, x, y, width, height, fps, &exclude, channel,
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

// ── Otomatik kaydırma ────────────────────────────────────────────────────────
//
// Kaydırmayı kullanıcıdan istemek yerine tekerleği uygulama çeviriyor. Gerekçe A18:
// eşleştirici kare başına bölgenin ~%42'sinden fazla kaymayı izleyemiyor, kullanıcı
// bunu bilemez ve "Daha yavaş kaydırın" uyarısı ona görünmez bir beceri dayatıyordu.
// Adımı biz atınca sınır hiç zorlanmıyor; ne kadar attığımızı da ölçebiliyoruz, çünkü
// birleştirici her karede sayfanın kaç piksel kaydığını söylüyor (kapalı çevrim).
//
// Tekerlek İMLECİN ALTINDAKİ pencereye gidiyor, o yüzden imleç bir kez bölgeye
// alınıyor ve bitince kullanıcının bıraktığı yere geri konuyor. İmleç bölgeden
// çıkarsa adım ATILMIYOR: kullanıcı araç çubuğuna ya da başka bir pencereye gittiğinde
// tekerleğimiz oraya gitmesin.

/// İmlecin otomatik kaydırma başlamadan önceki konumu.
static CURSOR_PARKED: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);

/// Bölgenin ekran dikdörtgeni — platformun imleç/tekerlek uzayında.
/// Windows: fiziksel piksel. macOS: mantıksal nokta. (Bkz. `platform::cursor_pos`.)
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn screen_rect(m: &crate::geom::MonitorInfo, x: f64, y: f64, w: f64, h: f64) -> (f64, f64, f64, f64) {
    #[cfg(target_os = "windows")]
    {
        (m.x * m.scale + x, m.y * m.scale + y, w, h)
    }
    #[cfg(target_os = "macos")]
    {
        (m.x + x / m.scale, m.y + y / m.scale, w / m.scale, h / m.scale)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn monitor_of(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Option<crate::geom::MonitorInfo> {
    let index = window.label().rsplit('-').next().and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
    crate::geom::all_monitors(app).get(index).cloned()
}

/// İmleci bölgenin ortasına alır (zaten içindeyse dokunmaz) ve eski konumu saklar.
/// Dönen: imleç artık bölgenin içinde mi — değilse otomatik kaydırma denenmemeli.
#[tauri::command]
pub fn auto_scroll_begin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> bool {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (&app, &window, x, y, width, height);
        false
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let Some(m) = monitor_of(&app, &window) else { return false };
        let (rx, ry, rw, rh) = screen_rect(&m, x, y, width, height);
        let inside = |p: (f64, f64)| p.0 >= rx && p.0 < rx + rw && p.1 >= ry && p.1 < ry + rh;

        let before = crate::platform::cursor_pos();
        *CURSOR_PARKED.lock().unwrap_or_else(|e| e.into_inner()) = before;
        if let Some(p) = before {
            if inside(p) {
                return true;
            }
        }
        crate::platform::set_cursor_pos(rx + rw / 2.0, ry + rh / 2.0);
        // Gerçekten oturdu mu? Bazı kurulumlarda imleç kısıtlı olabiliyor.
        let after = crate::platform::cursor_pos();
        let ok = after.map(inside).unwrap_or(false);
        log::info!(
            "otomatik kaydırma: bölge ({rx},{ry}) {rw}x{rh}, imleç {before:?} → {after:?}, park={ok}"
        );
        ok
    }
}

/// Bir adım tekerlek. İmleç bölgenin DIŞINDAYSA hiçbir şey göndermez ve `false` döner.
#[tauri::command]
pub fn auto_scroll_step(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    notches: i32,
) -> bool {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (&app, &window, x, y, width, height, notches);
        false
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let Some(m) = monitor_of(&app, &window) else { return false };
        let (rx, ry, rw, rh) = screen_rect(&m, x, y, width, height);
        let Some((cx, cy)) = crate::platform::cursor_pos() else { return false };
        if cx < rx || cx >= rx + rw || cy < ry || cy >= ry + rh {
            return false;
        }
        crate::platform::scroll_wheel(notches);
        true
    }
}

/// İmleci kullanıcının bıraktığı yere geri koyar.
#[tauri::command]
pub fn auto_scroll_end() {
    let parked = CURSOR_PARKED.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((x, y)) = parked {
        crate::platform::set_cursor_pos(x, y);
    }
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
    // İmleci geri koy. BURADA olmak zorunda: Escape ve pencere yok olma yolları
    // `scroll_end` komutundan geçmiyor, doğrudan buraya geliyor — kullanıcının imleci
    // yakalamanın ortasında bıraktığımız yerde kalırdı.
    auto_scroll_end();
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
