//! Video ekran kaydı.
//!
//! ## Neden Rust'ta
//!
//! `recorder.js` `getUserMedia({ chromeMediaSource: 'desktop' })` + `MediaRecorder` ile
//! çalışıyordu. `chromeMediaSource` Electron'a özgü bir uzantı — WebView2'de de yok,
//! WKWebView'da `getDisplayMedia` bile yok. Kayıt tamamen Rust'a taşındı ve kareler
//! webview'a HİÇ uğramıyor: eski `record-chunk` IPC trafiği (saniyede bir, megabaytlarca)
//! tamamen ortadan kalktı.
//!
//! ## Kazanç: sistem sesi için sanal aygıt GEREKMİYOR
//!
//! Electron sürümü macOS'ta sistem sesini alamıyor ve kullanıcıya "BlackHole gibi bir
//! sanal ses aygıtı gerekebilir" diyordu. ScreenCaptureKit sesi doğrudan veriyor
//! (Spike-4'te 8 saniyede 302 ses buffer'ı ölçüldü).
//!
//! ## Bilinen sınır: bitrate kontrolü yok
//!
//! `SCRecordingOutput` encode ve mux'u kendi içinde yapıyor ve bitrate ayarı sunmuyor.
//! Kalite kademesi bu yüzden ÇÖZÜNÜRLÜK üzerinden uygulanıyor (yüksek 1.0×, orta 0.75×,
//! düşük 0.5×) — dosya boyutu üzerinde gerçek bir kaldıraç, ama Electron'un
//! `videoBitsPerSecond`'ı kadar ince değil.
//!
//! İnce kontrol ve macOS 12.3 desteği için `objc2-av-foundation` ile doğrudan
//! `AVAssetWriter` yolu gerekiyor (bkz. plan §5.1). `SCRecordingOutput` macOS **15.0+**
//! ister; daha eski sürümlerde kayıt kapalı ve kullanıcıya söyleniyor.

#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use screencapturekit::prelude::*;
use screencapturekit::recording_output::{
    RecordingCallbacks, SCRecordingOutput, SCRecordingOutputCodec, SCRecordingOutputConfiguration,
    SCRecordingOutputFileType,
};

pub struct Recording {
    stream: SCStream,
    /// Kaydın yazıldığı geçici dosya. Kullanıcı kaydetmeyi iptal ederse yolu
    /// panoya gidiyor — kayıt kaybolmuyor.
    pub path: PathBuf,
    finished: Arc<AtomicBool>,
    failed: Arc<Mutex<Option<String>>>,
    /// Bu monitörün penceresi; durdurmada diğer overlay'lerin kapatılması için.
    pub window_label: String,
}

#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<Recording>>);

/// Kalite kademesi → çözünürlük çarpanı. Bkz. modül başındaki "bilinen sınır".
fn quality_scale(quality: &str) -> f64 {
    match quality {
        "low" => 0.5,
        "medium" => 0.75,
        _ => 1.0, // high / ultra
    }
}

/// Kayıt için gereken macOS sürümü var mı? `SCRecordingOutput` 15.0+ ister.
pub fn is_supported() -> bool {
    // Crate, özelliği `macos_15_0` feature'ı ardında sunuyor ve çalışma anında
    // nesne oluşturma başarısız olursa `None` dönüyor — asıl kontrol o.
    true
}

/// Kaydı başlatır. `crop_*` FİZİKSEL piksel.
#[allow(clippy::too_many_arguments)]
pub fn start(
    monitor: &crate::geom::MonitorInfo,
    crop_x: f64,
    crop_y: f64,
    crop_w: f64,
    crop_h: f64,
    quality: &str,
    capture_mic: bool,
    capture_system_audio: bool,
    window_label: String,
    out_path: PathBuf,
) -> Result<Recording, String> {
    let content = SCShareableContent::get().map_err(|e| e.to_string())?;
    let displays = content.displays();
    let tx = (monitor.x * monitor.scale).round() as i32;
    let ty = (monitor.y * monitor.scale).round() as i32;
    let display = displays
        .iter()
        .find(|d| {
            let f = d.frame();
            (f.origin.x * monitor.scale).round() as i32 == tx
                && (f.origin.y * monitor.scale).round() as i32 == ty
        })
        .or_else(|| displays.first())
        .ok_or("monitör bulunamadı")?;

    // Overlay'imiz (seçim çerçevesi, araç çubuğu, sayaç) kayda GİRMEMELİ.
    let excluded: Vec<_> = content
        .windows()
        .into_iter()
        .filter(|w| w.title().map(|t| t.contains("CopyBoard")).unwrap_or(false))
        .collect();

    let filter = SCContentFilter::create()
        .with_display(display)
        .with_excluding_windows(&excluded.iter().collect::<Vec<_>>())
        .build();

    let s = monitor.scale;
    let k = quality_scale(quality);
    // Çift sayıya yuvarla: H.264 tek boyutlu kareleri sevmiyor.
    let out_w = ((crop_w * k / 2.0).round() * 2.0).max(2.0) as u32;
    let out_h = ((crop_h * k / 2.0).round() * 2.0).max(2.0) as u32;

    let config = SCStreamConfiguration::new()
        .with_source_rect(CGRect {
            origin: CGPoint { x: crop_x / s, y: crop_y / s },
            size: CGSize { width: crop_w / s, height: crop_h / s },
        })
        .with_width(out_w)
        .with_height(out_h)
        .with_pixel_format(PixelFormat::BGRA)
        .with_fps(30)
        .with_shows_cursor(true)
        .with_captures_audio(capture_system_audio)
        .with_captures_microphone(capture_mic)
        // Kendi seslerimizi (toast vb.) kaydetme.
        .with_excludes_current_process_audio(true)
        .with_sample_rate(48_000)
        .with_channel_count(2)
        .with_queue_depth(8);

    let _ = std::fs::remove_file(&out_path);
    let rec_config = SCRecordingOutputConfiguration::new()
        .with_output_url(&out_path)
        .with_video_codec(SCRecordingOutputCodec::H264)
        .with_output_file_type(SCRecordingOutputFileType::MP4);

    let finished = Arc::new(AtomicBool::new(false));
    let failed: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let (f1, x1) = (finished.clone(), failed.clone());

    let callbacks = RecordingCallbacks::new()
        .on_start(|| log::info!("kayıt başladı"))
        .on_finish(move || {
            f1.store(true, Ordering::Release);
            log::info!("kayıt bitti");
        })
        .on_fail(move |e| {
            let msg = format!("{e:?}");
            log::error!("kayıt hatası: {msg}");
            *x1.lock().unwrap() = Some(msg);
        });

    let recording = SCRecordingOutput::new_with_delegate(&rec_config, callbacks)
        .ok_or("kayıt çıktısı oluşturulamadı (macOS 15.0+ gerekiyor)")?;

    let stream = SCStream::new(&filter, &config);
    stream.add_recording_output(&recording).map_err(|e| e.to_string())?;
    stream.start_capture().map_err(|e| e.to_string())?;

    log::info!(
        "kayıt: {out_w}x{out_h} @30fps, kalite={quality}, mikrofon={capture_mic}, sistem sesi={capture_system_audio}"
    );
    Ok(Recording { stream, path: out_path, finished, failed, window_label })
}

impl Recording {
    /// Akışı durdurur ve mux'un kapanmasını bekler. Dosya yolunu döner.
    pub fn stop(&mut self) -> Result<PathBuf, String> {
        self.stream.stop_capture().map_err(|e| e.to_string())?;

        // Mux'un dosyayı kapatması birkaç yüz milisaniye sürüyor. Beklemeden okumak
        // yarım bir mp4 verir.
        for _ in 0..50 {
            if self.finished.load(Ordering::Acquire) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        std::thread::sleep(std::time::Duration::from_millis(300));

        if let Some(err) = self.failed.lock().unwrap().clone() {
            return Err(err);
        }
        let size = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if size == 0 {
            return Err("kayıt dosyası boş".into());
        }
        Ok(self.path.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kalite_cozunurluk_carpanina_donusuyor() {
        assert_eq!(quality_scale("high"), 1.0);
        assert_eq!(quality_scale("ultra"), 1.0);
        assert_eq!(quality_scale("medium"), 0.75);
        assert_eq!(quality_scale("low"), 0.5);
        // Bilinmeyen değer en yüksek kaliteye düşer — kullanıcı kaydını bozmaktansa
        // büyük dosya üretmek yeğdir.
        assert_eq!(quality_scale("bilinmeyen"), 1.0);
    }

    #[test]
    fn cikti_boyutu_cift_sayiya_yuvarlaniyor() {
        // H.264 tek boyutlu kareleri sevmiyor; yuvarlama olmazsa encoder reddedebilir.
        let round = |v: f64, k: f64| ((v * k / 2.0).round() * 2.0).max(2.0) as u32;
        assert_eq!(round(1281.0, 1.0), 1282);
        assert_eq!(round(1281.0, 0.5), 640);
        assert_eq!(round(3.0, 0.5), 2);
        assert_eq!(round(1.0, 0.5), 2, "sıfır boyut üretilmemeli");
    }
}
