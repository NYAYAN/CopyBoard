//! Video kaydı ve kaydırmalı yakalama komutları.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::state::AppState;

// ── Ses ve kalite ayarları ───────────────────────────────────────────────────

#[tauri::command]
pub fn set_video_quality(app: tauri::AppHandle, value: String) {
    app.state::<AppState>().settings().set_video_quality(value);
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
pub fn record_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y, width, height, &window);
        crate::windows::toast::show(&app, "Video kaydı bu platformda henüz taşınmadı.", "error");
        return Err("desteklenmiyor".into());
    }

    #[cfg(target_os = "macos")]
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
        let path = std::env::temp_dir().join(format!(
            "copyboard_kayit_{}.mp4",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));

        let recording = crate::capture::recorder::start(
            &monitor, x, y, width, height,
            &quality,
            mic,
            system,
            label.clone(),
            path,
        )
        .map_err(|e| {
            crate::windows::toast::show(&app, &format!("Kayıt başlatılamadı: {e}"), "error");
            e
        })?;

        // Kayıt bir monitörde başladı — DİĞER monitörlerin overlay'leri gitsin.
        crate::capture::close_all_except(&app, &label);
        *app.state::<crate::capture::recorder::RecorderState>().0.lock().unwrap() = Some(recording);
        Ok(())
    }
}

/// Kaydı durdurur, kullanıcıya nereye kaydedeceğini sorar.
#[tauri::command]
pub fn record_stop(app: tauri::AppHandle) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
    }

    #[cfg(target_os = "macos")]
    {
        let taken = app
            .state::<crate::capture::recorder::RecorderState>()
            .0
            .lock()
            .unwrap()
            .take();
        let Some(mut recording) = taken else { return };
        let label = recording.window_label.clone();

        // Kaydedici penceresini HEMEN gizle ki kaydetme panelinin önünü kapatmasın.
        crate::windows::hide_if_open(&app, &label);

        let temp = match recording.stop() {
            Ok(p) => p,
            Err(e) => {
                crate::windows::toast::show(&app, &format!("Hata: Video verisi alınamadı ({e})"), "error");
                crate::capture::close_all(&app, None);
                return;
            }
        };

        let default_name = temp
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "kayit.mp4".into());
        let videos = app.path().video_dir().ok();
        let handle = app.clone();

        let mut builder = app.dialog().file().set_file_name(&default_name)
            .add_filter("Videos", &["mp4", "mov"]);
        if let Some(dir) = videos {
            builder = builder.set_directory(dir);
        }
        builder.save_file(move |chosen| {
            match chosen.and_then(|p| p.into_path().ok()) {
                Some(dest) => match std::fs::copy(&temp, &dest) {
                    Ok(_) => {
                        let _ = std::fs::remove_file(&temp);
                        crate::windows::toast::show(&handle, "Video Kaydedildi.", "success");
                    }
                    Err(e) => crate::windows::toast::show(&handle, &format!("Kaydetme Hatası: {e}"), "error"),
                },
                None => {
                    // İptal: kayıt KAYBOLMASIN — geçici dosyanın yolu panoya gitsin.
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
pub fn scroll_begin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y, width, height, channel, &window);
        crate::windows::toast::show(&app, "Kaydırmalı yakalama bu platformda henüz taşınmadı.", "error");
        return Err("desteklenmiyor".into());
    }

    #[cfg(target_os = "macos")]
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
                crate::capture::close_all(&handle, None);
            }
        });
        Ok(())
    }
}

#[tauri::command]
pub fn scroll_end(app: tauri::AppHandle) {
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
    #[cfg(target_os = "macos")]
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
