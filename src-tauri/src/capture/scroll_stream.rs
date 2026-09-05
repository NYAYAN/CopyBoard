//! Kaydırmalı yakalama için kare akışı.
//!
//! ## Neden Rust'ta
//!
//! `scroller.js` kareleri `getUserMedia({ chromeMediaSource: 'desktop' })` ile alıyordu.
//! Bu Electron'a özgü; WKWebView'da `getDisplayMedia` bile yok. Kareler artık
//! ScreenCaptureKit'ten geliyor ve webview'a `Channel` ile ham RGBA olarak akıyor.
//!
//! ## Neden HAM RGBA (sıkıştırılmamış)
//!
//! Spike-5 ölçtü: 2560×1600 bir karenin JPEG encode'u Rust'ta 39 ms sürüyor ve 15 fps'in
//! 66 ms'lik bütçesinin %60'ını yiyor — kare hızı 14,8'den 8,9'a DÜŞÜYOR. Ham RGBA ise
//! 234 MB/sn'de sıfır kare düşümüyle akıyor. **Tauri'nin ham bayt IPC'si sıkıştırmanın
//! CPU maliyetinden ucuz.**
//!
//! ## Neden ZATEN KIRPILMIŞ
//!
//! `sourceRect` ile yalnız kullanıcının seçtiği bölge yakalanıyor. Bu hem IPC'yi
//! (tam ekran yerine bölge) hem de JS tarafını sadeleştiriyor: `sampleFrame` artık
//! kırpma yapmıyor, geleni doğrudan `putImageData` ile basıyor.
//!
//! ## `stitcher.js` DEĞİŞMİYOR
//!
//! 476 satırlık birleştirme algoritması ve testi olduğu gibi kalıyor — Spike-5 akışın
//! yettiğini gösterdiği için Rust'a port gerekmedi.

#![cfg(target_os = "macos")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use screencapturekit::prelude::*;
use tauri::ipc::{Channel, InvokeResponseBody};

/// Kare başlığı: JS tarafı sıra atlamasını görebilsin ve boyutu doğrulayabilsin.
/// `u32 seq | u32 w | u32 h`
const HEADER: usize = 12;

pub struct ScrollStream {
    stream: SCStream,
    running: Arc<AtomicBool>,
}

impl ScrollStream {
    pub fn stop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Err(e) = self.stream.stop_capture() {
            log::warn!("kaydırma akışı durdurulamadı: {e}");
        }
    }
}

#[derive(Default)]
pub struct ScrollState(pub Mutex<Option<ScrollStream>>);

struct Handler {
    channel: Channel<InvokeResponseBody>,
    running: Arc<AtomicBool>,
    seq: Arc<std::sync::atomic::AtomicU32>,
}

impl SCStreamOutputTrait for Handler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        if !matches!(kind, SCStreamOutputType::Screen) || !self.running.load(Ordering::Acquire) {
            return;
        }
        let Some(pixel) = sample.image_buffer() else { return };
        let Ok(guard) = pixel.lock_read_only() else { return };
        let (w, h) = (guard.width() as u32, guard.height() as u32);
        if w == 0 || h == 0 {
            return;
        }

        // ScreenCaptureKit BGRA veriyor; canvas `ImageData` RGBA istiyor. `guard.row(y)`
        // satır sonu dolgusunu (stride) kendisi hallediyor.
        let mut out = Vec::with_capacity(HEADER + (w * h * 4) as usize);
        out.extend_from_slice(&[0u8; HEADER]);
        for y in 0..h as usize {
            let Some(row) = guard.row(y) else { continue };
            for px in row[..(w as usize) * 4].chunks_exact(4) {
                out.push(px[2]);
                out.push(px[1]);
                out.push(px[0]);
                out.push(255);
            }
        }

        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        out[0..4].copy_from_slice(&seq.to_le_bytes());
        out[4..8].copy_from_slice(&w.to_le_bytes());
        out[8..12].copy_from_slice(&h.to_le_bytes());

        let _ = self.channel.send(InvokeResponseBody::Raw(out));
    }
}

/// Kırpma bölgesinin kare akışını başlatır.
///
/// `crop_*` FİZİKSEL piksel (renderer bu uzayda çalışıyor); `sourceRect` NOKTA istediği
/// için ölçekle bölünüyor. Çıktı boyutu fiziksel piksel olarak veriliyor ki
/// `stitcher.js` beklediği çözünürlükte kare alsın.
pub fn start(
    monitor: &crate::geom::MonitorInfo,
    crop_x: f64,
    crop_y: f64,
    crop_w: f64,
    crop_h: f64,
    fps: u32,
    exclude_window_ids: &[u32],
    channel: Channel<InvokeResponseBody>,
) -> Result<ScrollStream, String> {
    let content = SCShareableContent::get().map_err(|e| e.to_string())?;
    let displays = content.displays();

    let target_x = (monitor.x * monitor.scale).round() as i32;
    let target_y = (monitor.y * monitor.scale).round() as i32;
    let display = displays
        .iter()
        .find(|d| {
            let f = d.frame();
            (f.origin.x * monitor.scale).round() as i32 == target_x
                && (f.origin.y * monitor.scale).round() as i32 == target_y
        })
        .or_else(|| displays.first())
        .ok_or("monitör bulunamadı")?;

    // Overlay'imiz akışa GİRMEMELİ: seçim çerçevesi, araç çubuğu ve HUD birleştirilen
    // sayfaya film olurdu. Pencere `content_protected` ile de korunuyor; bu ikinci hat.
    //
    // Ayıklama KİMLİKLE, başlıkla değil (bkz. `capture::overlay_window_ids`):
    // uygulamanın her penceresinin başlığı "CopyBoard" olduğu için başlığa bakan
    // filtre CopyBoard'un KENDİ arayüzünü de akıştan siliyordu.
    let excluded: Vec<_> = content
        .windows()
        .into_iter()
        .filter(|w| exclude_window_ids.contains(&w.window_id()))
        .collect();

    let filter = SCContentFilter::create()
        .with_display(display)
        .with_excluding_windows(&excluded.iter().collect::<Vec<_>>())
        .build();

    let s = monitor.scale;
    let config = SCStreamConfiguration::new()
        .with_source_rect(CGRect {
            origin: CGPoint { x: crop_x / s, y: crop_y / s },
            size: CGSize { width: crop_w / s, height: crop_h / s },
        })
        .with_width(crop_w.round() as u32)
        .with_height(crop_h.round() as u32)
        .with_pixel_format(PixelFormat::BGRA)
        .with_fps(fps)
        .with_shows_cursor(false)
        // Sığ kuyruk: birleştirme en TAZE kareyi istiyor, birikmiş eskileri değil.
        .with_queue_depth(4);

    let running = Arc::new(AtomicBool::new(true));
    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(
        Handler {
            channel,
            running: running.clone(),
            seq: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        },
        SCStreamOutputType::Screen,
    );
    stream.start_capture().map_err(|e| e.to_string())?;

    Ok(ScrollStream { stream, running })
}
