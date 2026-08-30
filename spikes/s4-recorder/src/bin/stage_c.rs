// S4 spike — AŞAMA C
//
// Soru: Aşama A+B'nin kareleri ve sesi, Chromium olmadan OYNATILABİLİR bir .mp4'e
// dönüşüyor mu?
//
// ── BULGU S4-b ───────────────────────────────────────────────────────────────
// İlk plan `videotoolbox` + `avassetwriter` crate'leriydi (SCK → IOSurface →
// H.264 → mp4). `avassetwriter 0.11.1` macOS 26 SDK'sıyla DERLENMİYOR: Swift
// köprüsü, bizim kullanmadığımız altyazı kodunda patlıyor —
//     Captions.swift:313: error: 'Position' is not a member type of
//     class 'AVFoundation.AVCaption.Ruby'
// Üçüncü parti bir Swift köprüsüne bağlanmak, SDK her yıl değiştiğinde kırılma
// riski demek. Üretimde `objc2-av-foundation` ile doğrudan bağlanılacak.
//
// Bu aşama, zincirin çalıştığını SCRecordingOutput (macOS 15.0+) ile ispatlıyor:
// ScreenCaptureKit yakalama+encode+mux'u kendi içinde yapar.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use screencapturekit::prelude::*;
use screencapturekit::recording_output::{
    RecordingCallbacks, SCRecordingOutput, SCRecordingOutputCodec, SCRecordingOutputConfiguration,
    SCRecordingOutputFileType,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(8);
    let out = std::env::args().nth(2).unwrap_or_else(|| "/tmp/s4-stage-c.mp4".into());
    let _ = std::fs::remove_file(&out);

    let (crop_w, crop_h) = (1280.0_f64, 720.0_f64);
    let (out_w, out_h) = (crop_w as u32 * 2, crop_h as u32 * 2);

    println!("── S4 / Aşama C ───────────────────────────────────────────");
    println!("çıktı   : {out}");
    println!("kırpma  : {crop_w}x{crop_h} nokta → {out_w}x{out_h} piksel");
    println!("codec   : H.264, mp4, sistem sesi açık");
    println!();

    let content = SCShareableContent::get()?;
    let display = &content.displays()[0];
    let filter = SCContentFilter::create()
        .with_display(display)
        .with_excluding_windows(&[])
        .build();

    let config = SCStreamConfiguration::new()
        .with_source_rect(CGRect {
            origin: CGPoint { x: 200.0, y: 150.0 },
            size: CGSize { width: crop_w, height: crop_h },
        })
        .with_width(out_w)
        .with_height(out_h)
        .with_pixel_format(PixelFormat::BGRA)
        .with_fps(30)
        .with_shows_cursor(true)
        .with_captures_audio(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(48_000)
        .with_channel_count(2)
        .with_queue_depth(8);

    let rec_config = SCRecordingOutputConfiguration::new()
        .with_output_url(Path::new(&out))
        .with_video_codec(SCRecordingOutputCodec::H264)
        .with_output_file_type(SCRecordingOutputFileType::MP4);

    println!("kullanılabilir codec'ler   : {:?}", rec_config.available_video_codecs());
    println!("kullanılabilir dosya tipleri: {:?}", rec_config.available_output_file_types());
    println!();

    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let failed: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));

    let (s1, f1, x1) = (started.clone(), finished.clone(), failed.clone());
    let callbacks = RecordingCallbacks::new()
        .on_start(move || { s1.store(true, Ordering::Relaxed); println!("[rec] başladı"); })
        .on_finish(move || { f1.store(true, Ordering::Relaxed); println!("[rec] bitti"); })
        .on_fail(move |e| {
            let msg = format!("{e:?}");
            println!("[rec] HATA: {msg}");
            *x1.lock().unwrap() = Some(msg);
        });

    let recording = SCRecordingOutput::new_with_delegate(&rec_config, callbacks)
        .ok_or("SCRecordingOutput oluşturulamadı")?;

    let mut stream = SCStream::new(&filter, &config);
    stream.add_recording_output(&recording)?;

    println!("{secs} saniye kaydediliyor…");
    stream.start_capture()?;
    std::thread::sleep(std::time::Duration::from_secs(secs));
    stream.stop_capture()?;

    // Mux'un kapanması için bekle
    for _ in 0..40 {
        if finished.load(Ordering::Relaxed) { break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));

    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    println!("\n── SONUÇ ──────────────────────────────────────────────────");
    println!("kayıt başladı : {}", started.load(Ordering::Relaxed));
    println!("kayıt bitti   : {}", finished.load(Ordering::Relaxed));
    if let Some(e) = failed.lock().unwrap().as_ref() { println!("hata          : {e}"); }
    println!("mp4 dosyası   : {:.2} MB   {}",
        size as f64 / 1_048_576.0,
        if size > 100_000 { "✅" } else { "❌ boş/eksik" });
    println!("\nDoğrulama: afplay/QuickTime ile açın, ya da");
    println!("  mdls -name kMDItemDurationSeconds -name kMDItemCodecs {out}");
    Ok(())
}
