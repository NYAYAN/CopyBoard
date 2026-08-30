// S4 spike — AŞAMA A + B
//
// Soru: macOS'ta Chromium olmadan, CopyBoard'un video kaydı için gereken üç şey
// elde edilebiliyor mu?
//   A) Belirli bir monitörün KIRPILMIŞ bir dikdörtgeninden düzenli kare akışı
//   B) SİSTEM SESİ — BlackHole gibi sanal ses aygıtı OLMADAN
//   C) H.264 encode + .mp4 mux            ← ayrı aşamada
//
// Bugün (Electron): getUserMedia({chromeMediaSource:'desktop'}) + MediaRecorder(webm).
// WKWebView'da bu yolun tamamı yok; buradaki ölçüm alternatifin gerçekliğini sınar.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use screencapturekit::prelude::*;

#[derive(Default)]
struct Counters {
    video_frames: AtomicU64,
    audio_buffers: AtomicU64,
    first_video_ns: AtomicU64,
    last_video_ns: AtomicU64,
    reported_size: AtomicU64, // (w << 32) | h
}

struct Handler {
    c: Arc<Counters>,
    t0: Instant,
}

impl SCStreamOutputTrait for Handler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        let ns = self.t0.elapsed().as_nanos() as u64;
        match kind {
            SCStreamOutputType::Screen => {
                let n = self.c.video_frames.fetch_add(1, Ordering::Relaxed);
                if n == 0 {
                    self.c.first_video_ns.store(ns, Ordering::Relaxed);
                    // İlk karede gerçek boyutu oku — kırpma gerçekten uygulandı mı?
                    if let Some(px) = sample.image_buffer() {
                        let w = px.width() as u64;
                        let h = px.height() as u64;
                        self.c.reported_size.store((w << 32) | h, Ordering::Relaxed);
                    }
                }
                self.c.last_video_ns.store(ns, Ordering::Relaxed);
            }
            SCStreamOutputType::Audio => {
                self.c.audio_buffers.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(6);

    println!("── S4 / Aşama A+B ─────────────────────────────────────────");
    let content = SCShareableContent::get()?;
    let displays = content.displays();
    println!("Paylaşılabilir monitör: {}", displays.len());
    let display = &displays[0];

    // CopyBoard'un tipik "bölge kaydı" senaryosu: monitörün ortasından 1280x720.
    // sourceRect ScreenCaptureKit'te NOKTA (mantıksal) cinsindendir.
    let (crop_w, crop_h) = (1280.0_f64, 720.0_f64);
    let crop = CGRect {
        origin: CGPoint { x: 200.0, y: 150.0 },
        size: CGSize { width: crop_w, height: crop_h },
    };

    let filter = SCContentFilter::create()
        .with_display(display)
        .with_excluding_windows(&[]) // gerçek uygulamada: overlay penceremiz burada dışlanır
        .build();

    let config = SCStreamConfiguration::new()
        .with_source_rect(crop)
        .with_width(crop_w as u32 * 2)   // 2x monitörde retina çıktı
        .with_height(crop_h as u32 * 2)
        .with_pixel_format(PixelFormat::BGRA)
        .with_fps(30)
        .with_shows_cursor(true)
        .with_captures_audio(true)                    // ← B: sistem sesi
        .with_excludes_current_process_audio(true)     // kendi sesimizi kaydetme
        .with_sample_rate(48_000)
        .with_channel_count(2)
        .with_queue_depth(8);

    let counters = Arc::new(Counters::default());
    let t0 = Instant::now();

    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(Handler { c: counters.clone(), t0 }, SCStreamOutputType::Screen);
    stream.add_output_handler(Handler { c: counters.clone(), t0 }, SCStreamOutputType::Audio);

    println!("kırpma  : {}x{} nokta @ ({}, {})", crop_w, crop_h, crop.origin.x, crop.origin.y);
    println!("çıktı   : {}x{} piksel, 30 fps, BGRA", crop_w as u32 * 2, crop_h as u32 * 2);
    println!("ses     : captures_audio=true, 48kHz stereo");
    println!("{secs} saniye kaydediliyor…\n");

    stream.start_capture()?;
    std::thread::sleep(std::time::Duration::from_secs(secs));
    stream.stop_capture()?;
    std::thread::sleep(std::time::Duration::from_millis(300)); // son buffer'lar

    let v = counters.video_frames.load(Ordering::Relaxed);
    let a = counters.audio_buffers.load(Ordering::Relaxed);
    let first = counters.first_video_ns.load(Ordering::Relaxed);
    let last = counters.last_video_ns.load(Ordering::Relaxed);
    let span_s = (last.saturating_sub(first)) as f64 / 1e9;
    let fps = if span_s > 0.0 { (v.saturating_sub(1)) as f64 / span_s } else { 0.0 };
    let sz = counters.reported_size.load(Ordering::Relaxed);
    let (rw, rh) = ((sz >> 32) as u32, (sz & 0xffff_ffff) as u32);

    println!("── SONUÇ ──────────────────────────────────────────────────");
    println!("A) video kareleri : {v}   (ilk kare {:.0} ms sonra)", first as f64 / 1e6);
    println!("   ölçülen fps    : {fps:.1}   (hedef 30)");
    println!("   kare boyutu    : {rw}x{rh}   {}",
        if rw == crop_w as u32 * 2 && rh == crop_h as u32 * 2 { "✅ kırpma uygulandı" } else { "⚠ beklenenden farklı" });
    println!("B) ses buffer'ları: {a}   {}",
        if a > 0 { "✅ SİSTEM SESİ VAR — sanal aygıt gerekmedi" } else { "❌ ses gelmedi (sessizlikte de buffer beklenir)" });
    println!();
    println!("Aşama C (H.264 encode + mp4 mux) ayrı çalıştırılacak.");

    Ok(())
}
