// S5 spike — Kaydırmalı yakalamanın kare akışı Tauri IPC'sinden geçebiliyor mu?
//
// Bugün (Electron): scroller.js canlı masaüstü akışını getUserMedia ile RENDERER'DA
// alıyor; kareler hiç IPC'den geçmiyor. stitcher.js (476 satır) aynı süreçte çalışıyor.
//
// Tauri'de getUserMedia yok (WKWebView). Kareleri Rust yakalayıp webview'a Channel ile
// göndermek gerekiyor. Soru: bu boru hattı 15 fps'i kaldırıyor mu, yoksa stitcher.js'i
// de Rust'a portlamak mı gerekiyor?
//
// Aynı ölçüm S3-b kararını da kapatıyor: yakalama overlay'ine ham RGBA mı, kodlanmış
// görüntü mü göndermeli?
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use screencapturekit::prelude::*;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager as _;

// Her kareye 24 baytlık başlık: JS tarafı sıra atlamasını ve gecikmeyi ölçebilsin.
//   u32 seq | u32 w | u32 h | u32 mode | f64 sent_ms
const HEADER: usize = 24;

fn header(seq: u32, w: u32, h: u32, mode: u32, sent_ms: f64) -> [u8; HEADER] {
    let mut b = [0u8; HEADER];
    b[0..4].copy_from_slice(&seq.to_le_bytes());
    b[4..8].copy_from_slice(&w.to_le_bytes());
    b[8..12].copy_from_slice(&h.to_le_bytes());
    b[12..16].copy_from_slice(&mode.to_le_bytes());
    b[16..24].copy_from_slice(&sent_ms.to_le_bytes());
    b
}

struct Streamer {
    channel: Channel<InvokeResponseBody>,
    mode: String,
    jpeg_quality: u8,
    seq: std::sync::atomic::AtomicU32,
    running: Arc<AtomicBool>,
    t0: std::time::Instant,
    // Rust tarafı ölçümleri
    convert_ns: std::sync::atomic::AtomicU64,
    sent_bytes: std::sync::atomic::AtomicU64,
    captured: std::sync::atomic::AtomicU32,
}

// ── BULGU S5-a ───────────────────────────────────────────────────────────────
// `impl SCStreamOutputTrait for Arc<Streamer>` YASAK — yetim kuralı (orphan rule):
// Arc yabancı bir tip ve #[fundamental] değil (Box'ın aksine). Paylaşılan durumu
// handler'a taşımak için yerel bir newtype gerekiyor.
struct Handler(Arc<Streamer>);

impl SCStreamOutputTrait for Handler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        if !matches!(kind, SCStreamOutputType::Screen) || !self.0.running.load(Ordering::Relaxed) {
            return;
        }
        let Some(pixel) = sample.image_buffer() else { return };
        self.0.captured.fetch_add(1, Ordering::Relaxed);

        // lock_read_only() → guard; guard.row(y) satır satır verir ve stride'ı
        // (satır sonu padding'ini) kendisi halleder — ScreenCaptureKit'in BGRA
        // buffer'ında bytes_per_row genelde w*4'ten büyüktür.
        let Ok(guard) = pixel.lock_read_only() else { return };
        let (w, h) = (guard.width() as u32, guard.height() as u32);

        let tc = std::time::Instant::now();
        // ScreenCaptureKit BGRA verir; satır sonlarında padding olabilir (stride > w*4).
        let mut payload: Vec<u8>;
        let mode_id: u32;
        match self.0.mode.as_str() {
            "jpeg" => {
                mode_id = 2;
                // BGRA → RGB (JPEG alpha almaz)
                let mut rgb = Vec::with_capacity((w * h * 3) as usize);
                for y in 0..h as usize {
                    let Some(row) = guard.row(y) else { continue };
                    for px in row[..(w as usize) * 4].chunks_exact(4) {
                        rgb.push(px[2]); rgb.push(px[1]); rgb.push(px[0]);
                    }
                }
                let mut out = Vec::with_capacity(HEADER + (w * h) as usize / 8);
                out.extend_from_slice(&[0u8; HEADER]);
                {
                    use image::ImageEncoder;
                    let _ = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, self.0.jpeg_quality)
                        .write_image(&rgb, w, h, image::ExtendedColorType::Rgb8);
                }
                payload = out;
            }
            _ => {
                mode_id = 1; // ham RGBA — JS'te doğrudan ImageData'ya girer
                let mut out = Vec::with_capacity(HEADER + (w * h * 4) as usize);
                out.extend_from_slice(&[0u8; HEADER]);
                for y in 0..h as usize {
                    let Some(row) = guard.row(y) else { continue };
                    for px in row[..(w as usize) * 4].chunks_exact(4) {
                        out.push(px[2]); out.push(px[1]); out.push(px[0]); out.push(255);
                    }
                }
                payload = out;
            }
        }
        self.0.convert_ns.fetch_add(tc.elapsed().as_nanos() as u64, Ordering::Relaxed);

        let seq = self.0.seq.fetch_add(1, Ordering::Relaxed);
        let sent_ms = self.0.t0.elapsed().as_secs_f64() * 1000.0;
        payload[..HEADER].copy_from_slice(&header(seq, w, h, mode_id, sent_ms));
        self.0.sent_bytes.fetch_add(payload.len() as u64, Ordering::Relaxed);

        let _ = self.0.channel.send(InvokeResponseBody::Raw(payload));
    }
}

struct Active(std::sync::Mutex<Option<(SCStream, Arc<Streamer>, Arc<AtomicBool>)>>);

#[tauri::command]
async fn start_stream(
    state: tauri::State<'_, Active>,
    channel: Channel<InvokeResponseBody>,
    mode: String,
    jpeg_quality: u8,
    crop_w: f64,
    crop_h: f64,
    scale: u32,
    fps: u32,
) -> Result<serde_json::Value, String> {
    stop_inner(&state);

    let content = SCShareableContent::get().map_err(|e| e.to_string())?;
    let display = content.displays().first().cloned().ok_or("monitör yok")?;
    let filter = SCContentFilter::create().with_display(&display).with_excluding_windows(&[]).build();

    let (out_w, out_h) = (crop_w as u32 * scale, crop_h as u32 * scale);
    let config = SCStreamConfiguration::new()
        .with_source_rect(CGRect {
            origin: CGPoint { x: 100.0, y: 100.0 },
            size: CGSize { width: crop_w, height: crop_h },
        })
        .with_width(out_w)
        .with_height(out_h)
        .with_pixel_format(PixelFormat::BGRA)
        .with_fps(fps)
        .with_shows_cursor(false)
        .with_queue_depth(6);

    let running = Arc::new(AtomicBool::new(true));
    let streamer = Arc::new(Streamer {
        channel,
        mode: mode.clone(),
        jpeg_quality,
        seq: std::sync::atomic::AtomicU32::new(0),
        running: running.clone(),
        t0: std::time::Instant::now(),
        convert_ns: std::sync::atomic::AtomicU64::new(0),
        sent_bytes: std::sync::atomic::AtomicU64::new(0),
        captured: std::sync::atomic::AtomicU32::new(0),
    });

    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(Handler(streamer.clone()), SCStreamOutputType::Screen);
    stream.start_capture().map_err(|e| e.to_string())?;

    let info = serde_json::json!({
        "mode": mode, "jpegQuality": jpeg_quality,
        "cropPoints": { "w": crop_w, "h": crop_h },
        "outputPixels": { "w": out_w, "h": out_h },
        "fps": fps,
        "rawFrameBytes": out_w * out_h * 4
    });
    *state.0.lock().unwrap() = Some((stream, streamer, running));
    Ok(info)
}

fn stop_inner(state: &tauri::State<'_, Active>) -> Option<serde_json::Value> {
    let taken = state.0.lock().unwrap().take();
    let (stream, streamer, running) = taken?;
    running.store(false, Ordering::Relaxed);
    let _ = stream.stop_capture();
    let sent = streamer.seq.load(Ordering::Relaxed);
    let captured = streamer.captured.load(Ordering::Relaxed);
    Some(serde_json::json!({
        "framesCaptured": captured,
        "framesSent": sent,
        "bytesSent": streamer.sent_bytes.load(Ordering::Relaxed),
        "convertMsTotal": streamer.convert_ns.load(Ordering::Relaxed) as f64 / 1e6,
        "convertMsPerFrame": if sent > 0 {
            streamer.convert_ns.load(Ordering::Relaxed) as f64 / 1e6 / sent as f64 } else { 0.0 },
    }))
}

#[tauri::command]
async fn stop_stream(state: tauri::State<'_, Active>) -> Result<serde_json::Value, String> {
    Ok(stop_inner(&state).unwrap_or(serde_json::json!({ "framesSent": 0 })))
}

#[tauri::command]
fn is_auto() -> bool {
    std::env::args().any(|a| a == "--auto")
}

// JS tarafının ölçümünü stdout'a bas — diğer spike'larla aynı biçim.
#[tauri::command]
fn report_result(app: tauri::AppHandle, result: serde_json::Value) {
    println!("\n===SPIKE_RESULT_JSON===\n{}\n===END===",
        serde_json::to_string_pretty(&result).unwrap());
    if std::env::args().any(|a| a == "--exit") {
        let h = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            h.exit(0);
        });
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Active(std::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![start_stream, stop_stream, report_result, is_auto])
        .run(tauri::generate_context!())
        .expect("tauri çalıştırılamadı");
}
