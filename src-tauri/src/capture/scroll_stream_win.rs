//! Kaydırmalı yakalama kare akışı — Windows.
//!
//! macOS'taki `scroll_stream.rs`'in (ScreenCaptureKit) karşılığı: seçilen bölgenin
//! ZATEN KIRPILMIŞ ham RGBA kareleri, `u32 seq | u32 w | u32 h | RGBA` düzeniyle bir
//! `Channel` üzerinden renderer'a akıyor. `stitcher.js` iki platformda da aynı veriyi
//! görüyor; yalnız kaynağı farklı.
//!
//! Kareler Windows.Graphics.Capture'dan (`windows-capture`). WGC içerik değişince kare
//! veriyor — kaydırmada tam istediğimiz şey; `fps` üst sınırı burada uygulanıyor
//! (Spike-5: 15 fps, sıkıştırma YOK). Overlay `WDA_EXCLUDEFROMCAPTURE` ile kurulu,
//! karelere girmiyor; bu yüzden `exclude_window_ids` Windows'ta kullanılmıyor.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Clone, Copy)]
struct Crop {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

struct Flags {
    channel: Channel<InvokeResponseBody>,
    crop: Crop,
    min_interval: Duration,
    seq: Arc<AtomicU32>,
}

struct Handler {
    channel: Channel<InvokeResponseBody>,
    crop: Crop,
    min_interval: Duration,
    last_sent: Option<Instant>,
    seq: Arc<AtomicU32>,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = BoxError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let f = ctx.flags;
        Ok(Self { channel: f.channel, crop: f.crop, min_interval: f.min_interval, last_sent: None, seq: f.seq })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let now = Instant::now();
        if let Some(last) = self.last_sent {
            if now.duration_since(last) < self.min_interval {
                return Ok(());
            }
        }
        let fw = frame.width();
        let fh = frame.height();
        let x0 = self.crop.x.min(fw.saturating_sub(1));
        let y0 = self.crop.y.min(fh.saturating_sub(1));
        let x1 = (self.crop.x + self.crop.w).min(fw);
        let y1 = (self.crop.y + self.crop.h).min(fh);
        if x1 <= x0 || y1 <= y0 {
            return Ok(());
        }
        let (w, h) = (x1 - x0, y1 - y0);

        let mut buf = frame.buffer_crop(x0, y0, x1, y1)?;
        let px = buf.as_nopadding_buffer()?;

        // Kare düzeni: u32 seq | u32 w | u32 h | RGBA (bkz. api-tauri.js scrollBegin)
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let mut out = Vec::with_capacity(12 + px.len());
        out.extend_from_slice(&seq.to_le_bytes());
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(px);
        // Kanal kapanmışsa (pencere gitti) sessizce düşer; `stop` zaten yolda.
        let _ = self.channel.send(InvokeResponseBody::Raw(out));
        self.last_sent = Some(now);
        Ok(())
    }
}

pub struct ScrollStream {
    control: Option<CaptureControl<Handler, BoxError>>,
}

impl ScrollStream {
    pub fn stop(&mut self) {
        if let Some(control) = self.control.take() {
            if let Err(e) = control.stop() {
                log::warn!("kaydırma akışı durdurulurken: {e}");
            }
        }
    }
}

#[derive(Default)]
pub struct ScrollState(pub Mutex<Option<ScrollStream>>);

fn wgc_monitor(monitor: &crate::geom::MonitorInfo) -> Result<Monitor, String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};

    let cx = ((monitor.x + monitor.width / 2.0) * monitor.scale).round() as i32;
    let cy = ((monitor.y + monitor.height / 2.0) * monitor.scale).round() as i32;
    // SAFETY: saf sorgu.
    let h = unsafe { MonitorFromPoint(POINT { x: cx, y: cy }, MONITOR_DEFAULTTONEAREST) };
    if h.0.is_null() {
        return Err("monitör bulunamadı (HMONITOR null)".into());
    }
    Ok(Monitor::from_raw_hmonitor(h.0))
}

/// Akışı başlatır. `crop_*` FİZİKSEL piksel, monitöre göreli. `exclude_window_ids`
/// macOS imzasıyla uyum için alınıyor; Windows'ta overlay zaten yakalamadan dışlanmış.
#[allow(clippy::too_many_arguments)]
pub fn start(
    monitor: &crate::geom::MonitorInfo,
    crop_x: f64,
    crop_y: f64,
    crop_w: f64,
    crop_h: f64,
    fps: u32,
    _exclude_window_ids: &[u32],
    channel: Channel<InvokeResponseBody>,
) -> Result<ScrollStream, String> {
    let wgc = wgc_monitor(monitor)?;
    let crop = Crop {
        x: crop_x.max(0.0).round() as u32,
        y: crop_y.max(0.0).round() as u32,
        w: crop_w.max(1.0).round() as u32,
        h: crop_h.max(1.0).round() as u32,
    };
    let min_interval = Duration::from_millis(1000 / fps.max(1) as u64);
    let seq = Arc::new(AtomicU32::new(0));

    let make = |border: DrawBorderSettings, channel: Channel<InvokeResponseBody>, seq: Arc<AtomicU32>| {
        Settings::new(
            wgc,
            // Kaydırılan sayfada imleç istenmez: birleştirici dikişte yanlış eşleşme yapar.
            CursorCaptureSettings::WithoutCursor,
            border,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            Flags { channel, crop, min_interval, seq },
        )
    };

    let control = match Handler::start_free_threaded(make(DrawBorderSettings::WithoutBorder, channel.clone(), seq.clone())) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("kaydırma: kenarlıksız yakalama açılamadı ({e}), varsayılanla deneniyor");
            Handler::start_free_threaded(make(DrawBorderSettings::Default, channel, seq))
                .map_err(|e| format!("ekran akışı başlatılamadı: {e}"))?
        }
    };

    log::info!("kaydırma akışı: {}x{} @{fps}fps (ham RGBA)", crop.w, crop.h);
    Ok(ScrollStream { control: Some(control) })
}
