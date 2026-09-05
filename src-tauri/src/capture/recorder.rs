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
//! ## Neden `SCRecordingOutput` değil `AVAssetWriter`
//!
//! İlk port `SCRecordingOutput` kullanıyordu: encode ve mux'u kendi yapıyor, kod az.
//! Ama **bit hızı ayarı sunmuyor** ve ölçüldüğünde (BULGU R-19) sıkıştırılamaz gürültüde
//! bile 1280×720@54fps'te ~10 Mbps'te tıkandığı görüldü — Apple'ın sabit bütçesi.
//! Electron `videoBitsPerSecond` veriyordu (ultra 50, high 25 Mbps) ve fark kullanıcıya
//! "görüntü kalitesi düştü" olarak yansıyordu.
//!
//! Artık kareler `SCStream`den alınıp [`crate::capture::writer::AssetWriter`] ile
//! yazılıyor; kalite kademesi hem KARE HIZINI hem BİT HIZINI belirliyor, Electron'daki
//! gibi. Çözünürlük ölçeği yalnız düşük kademelerde korunuyor (dosya boyutu için).

#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use screencapturekit::cm::{CMSampleBufferSCExt, CMSampleBuffer, SCFrameStatus};
use screencapturekit::dispatch_queue::{DispatchQoS, DispatchQueue};
use screencapturekit::prelude::*;
use screencapturekit::stream::output_trait::SCStreamOutputTrait;
use screencapturekit::stream::output_type::SCStreamOutputType;

use super::writer::AssetWriter;

pub struct Recording {
    stream: SCStream,
    /// Kareleri yazan AVAssetWriter. Akış geri çağrılarıyla paylaşıldığı için `Arc`.
    writer: Arc<AssetWriter>,
    /// Kaydın yazıldığı geçici dosya. Kullanıcı kaydetmeyi iptal ederse yolu
    /// panoya gidiyor — kayıt kaybolmuyor.
    pub path: PathBuf,
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

/// Kalite kademesi → kare hızı. Electron'daki eşleme birebir korunuyor.
///
/// Arayüz bu sayıları KULLANICIYA VAAT EDİYOR ("Yüksek (60fps)", "Ultra (60fps)"),
/// ama port `with_fps(30)` ile sabitlenmişti: her kademe 30 fps kaydediyordu. Hareketli
/// içerikte fark bariz — kullanıcı bunu "görüntü kalitesi düştü" olarak görüyor.
///
/// | Kademe | Electron | Port (önce) | Şimdi |
/// |---|---|---|---|
/// | ultra  | 60 | 30 | 60 |
/// | high   | 60 | 30 | 60 |
/// | medium | 30 | 30 | 30 |
/// | low    | 30 | 30 | 30 |
///
/// SCStream için bu bir TAVAN: ekran daha seyrek güncelleniyorsa o kadar kare üretilir.
fn quality_fps(quality: &str) -> u32 {
    match quality {
        "low" | "medium" => 30,
        _ => 60, // high / ultra
    }
}

/// Kayıt için gereken macOS sürümü var mı? `SCRecordingOutput` 15.0+ ister.
///
/// `capture::start` bunu overlay açılmadan ÖNCE soruyor: paket 12.3'e kadar iniyor ve
/// 12–14'te kullanıcıya bölge seçtirip sonra "oluşturulamadı" demek kötü bir deneyim.
pub fn is_supported() -> bool {
    let v = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    v.majorVersion >= 15
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
    let fps = quality_fps(quality);
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
        // ── Piksel biçimi: YUV, BGRA DEĞİL ───────────────────────────────────
        // H.264 kodlayıcısı YCbCr istiyor. BGRA verildiğinde `AVAssetWriter` İLK
        // kareyi kabul ediyor, sonra kodlayıcı ASENKRON çöküyor (-16122) ve yazıcı
        // `Failed` durumuna düşüp sonraki her kareyi reddediyor: ölçümde 1 kare
        // yazılıp 300 kare düşürülüyordu. Hata mesajı biçimden hiç söz etmiyor,
        // bu yüzden ayarları ve zamanlamayı eleyerek bulundu.
        //
        // Kaydırmalı yakalama (`scroll_stream`) BGRA kullanmaya devam ediyor: orada
        // kareler CPU'da birleştiriliyor, yani paketlenmiş RGB gerekiyor. Burada
        // kareye hiç dokunmuyoruz, doğrudan kodlayıcıya gidiyor — dönüşüm de bedava
        // kalkmış oluyor.
        .with_pixel_format(PixelFormat::YCbCr_420v)
        .with_fps(fps)
        .with_shows_cursor(true)
        .with_captures_audio(capture_system_audio)
        .with_captures_microphone(capture_mic)
        // Kendi seslerimizi (toast vb.) kaydetme.
        .with_excludes_current_process_audio(true)
        .with_sample_rate(48_000)
        .with_channel_count(2)
        .with_queue_depth(8);

    // AVAssetWriter var olan dosyayı reddediyor.
    let _ = std::fs::remove_file(&out_path);

    let bitrate = super::writer::quality_bitrate(quality);
    let writer = Arc::new(AssetWriter::new(
        &out_path,
        out_w,
        out_h,
        fps,
        bitrate,
        capture_system_audio || capture_mic,
    )?);

    // ── Akış çıktısı ─────────────────────────────────────────────────────────
    // Görüntü ve ses AYRI işleyiciler ve AYRI kuyruklardan geliyor; ikisi de aynı
    // `AssetWriter`a yazıyor. Eş zamanlılık orada input başına `Mutex` ile çözülü.
    struct Sink(Arc<AssetWriter>);
    impl SCStreamOutputTrait for Sink {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
            // Hazır olmayan tamponu eklemek yazıcıyı hata durumuna düşürür.
            if !sample.is_valid() || !sample.data_is_ready() {
                return;
            }
            // ScreenCaptureKit ekran DEĞİŞMEDİĞİNDE de kare yolluyor — ama bu
            // karelerde piksel verisi YOK (`Idle`, `Blank`, `Suspended`). Yazıcıya
            // verilirse ekleme başarısız oluyor ve yazıcı hata durumuna düşüp bir
            // daha hiçbir kareyi kabul etmiyor: ölçümde 1 kare yazıldı, 537 düşürüldü.
            // Yalnız gerçekten içerik taşıyan kareler geçiyor.
            // Filtre "izin verilenler" değil "reddedilenler" listesi: `frame_status()`
            // ek bilgi bulamazsa `None` dönüyor ve beyaz liste yaklaşımı o durumda
            // HER kareyi eliyordu (ölçümde sıfır kare yazıldı).
            if of_type == SCStreamOutputType::Screen {
                if matches!(
                    sample.frame_status(),
                    Some(SCFrameStatus::Idle)
                        | Some(SCFrameStatus::Blank)
                        | Some(SCFrameStatus::Suspended)
                ) {
                    return;
                }
            }
            let ptr = sample.as_ptr();
            match of_type {
                SCStreamOutputType::Screen => {
                    let pts = sample.presentation_timestamp();
                    // apple_cf ve objc2-core-media CMTime'ları alan alan aynı
                    // (`value`, `timescale`, `flags`, `epoch`) — C ABI'sinde tek tip.
                    let pts = objc2_core_media::CMTime {
                        value: pts.value,
                        timescale: pts.timescale,
                        flags: objc2_core_media::CMTimeFlags(pts.flags),
                        epoch: pts.epoch,
                    };
                    // ── `image_buffer_ptr()` DEĞİL, `image_buffer()` ──────────────
                    // Alttaki Swift köprüsü piksel tamponunu **+1 (passRetained)**
                    // döndürüyor — kütüphanenin kendi güvenlik notu bunu söylüyor.
                    // `image_buffer_ptr()` o +1'i sahipsiz bırakıyor, yani her kare
                    // bir retain sızdırıyor ve ScreenCaptureKit'in havuzu tam
                    // `queueDepth` karede tükenip akış tamamen duruyordu (ölçüm:
                    // derinlik 8 → 8 kare, derinlik 32 → 32 kare, sonra sıfır;
                    // hiçbir şey yapmayan bir işleyici aynı sürede 572 kare alıyordu).
                    //
                    // `image_buffer()` +1'i sahipleniyor ve `Drop` ile bırakıyor.
                    // Sarmalayıcı ekleme bitene kadar CANLI tutulmalı.
                    let Some(pb) = sample.image_buffer() else { return };
                    unsafe { self.0.append_video(pb.as_ptr(), pts) };
                    drop(pb);
                }
                SCStreamOutputType::Audio | SCStreamOutputType::Microphone => {
                    unsafe { self.0.append_audio(ptr) };
                }
            }
        }
    }

    // ── İşleyiciler KENDİ kuyruklarında ──────────────────────────────────────
    // Varsayılan kuyrukta encode çağrısı, karelerin teslim edildiği kuyruğu bloke
    // ediyor: ScreenCaptureKit havuzundaki tamponlar tükenince akış tamamen duruyor.
    // Ölçüldü — hiçbir şey yapmayan bir işleyici 10 saniyede 572 kare alırken,
    // yazıcıya bağlı olan tam `queueDepth` kadar (8, derinlik 32'yken 32) kare alıp
    // susuyordu. Ayrı kuyruk, encode'u teslimden ayırıyor.
    let vq = DispatchQueue::new("com.copyboard.record.video", DispatchQoS::UserInteractive);
    let aq = DispatchQueue::new("com.copyboard.record.audio", DispatchQoS::UserInitiated);

    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler_with_queue(
        Sink(writer.clone()),
        SCStreamOutputType::Screen,
        Some(&vq),
    );
    if capture_system_audio {
        stream.add_output_handler_with_queue(
            Sink(writer.clone()),
            SCStreamOutputType::Audio,
            Some(&aq),
        );
    }
    if capture_mic {
        stream.add_output_handler_with_queue(
            Sink(writer.clone()),
            SCStreamOutputType::Microphone,
            Some(&aq),
        );
    }
    stream.start_capture().map_err(|e| e.to_string())?;

    log::info!(
        "kayıt: {out_w}x{out_h} @{fps}fps, {:.1} Mbps, kalite={quality}, mikrofon={capture_mic}, sistem sesi={capture_system_audio}",
        f64::from(bitrate) / 1e6
    );
    Ok(Recording { stream, writer, path: out_path, window_label })
}

impl Recording {
    /// Akışı durdurur ve mux'un kapanmasını bekler. Dosya yolunu döner.
    pub fn stop(&mut self) -> Result<PathBuf, String> {
        let t0 = std::time::Instant::now();

        // Sıra ÖNEMLİ: önce kare akışı kesilir, sonra yazıcı sonlandırılır. Ters
        // sırada, sonlandırma sürerken gelen kareler kapanmış bir input'a eklenmeye
        // çalışılır ve yazıcı hata durumuna düşer.
        self.stream.stop_capture().map_err(|e| e.to_string())?;
        let t_capture = t0.elapsed();

        let t1 = std::time::Instant::now();
        let result = self.writer.finish(std::time::Duration::from_secs(10));
        let t_mux = t1.elapsed();

        log::info!(
            "durdurma süreleri: yakalama={t_capture:?} yazma={t_mux:?} toplam={:?}",
            t0.elapsed()
        );

        result?;

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
    fn kalite_kademesi_kare_hizina_donusuyor() {
        // Arayüz "Yüksek (60fps)" ve "Ultra (60fps)" yazıyor; kod bunu tutmalı.
        assert_eq!(quality_fps("ultra"), 60);
        assert_eq!(quality_fps("high"), 60);
        assert_eq!(quality_fps("medium"), 30);
        assert_eq!(quality_fps("low"), 30);
        // Bilinmeyen değer en iyi kademeye düşer — quality_scale ile aynı politika.
        assert_eq!(quality_fps("bilinmeyen"), 60);
    }

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
