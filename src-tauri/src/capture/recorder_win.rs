//! Video ekran kaydı — Windows.
//!
//! macOS'taki `recorder.rs`'in (ScreenCaptureKit + `SCRecordingOutput`) karşılığı.
//! Kareler Windows.Graphics.Capture'dan (`windows-capture` crate'i), kodlama ve mux
//! Media Foundation Sink Writer'dan (`mf_writer.rs`: H.264 + AAC → MP4), ses WASAPI'den
//! (`wasapi.rs`: mikrofon ve/veya sistem sesi loopback). Electron sürümü bunu
//! `getUserMedia({chromeMediaSource:'desktop'})` + `MediaRecorder` ile WebM'e yazıyordu;
//! WebView2'de o yol yok.
//!
//! ## Kırpma
//!
//! WGC monitörün TAMAMINI veriyor; seçilen bölge her karede GPU'da kırpılıyor
//! (`Frame::buffer_crop`) ve yazıcıya yalnız o dikdörtgen gidiyor. Overlay'imiz
//! `WDA_EXCLUDEFROMCAPTURE` ile kurulduğu için karelere hiç girmiyor.
//!
//! ## Kare hızı ve zaman
//!
//! WGC yalnız içerik DEĞİŞİNCE kare veriyor; 30 fps'ye eşitlemek için 1/30 sn'den yakın
//! kareler atlanıyor. Zaman damgaları WGC'nin QPC tabanlı `SystemRelativeTime`'ından,
//! kaydın QPC başlangıcına (`t0`) göre; ses de aynı `t0`'ı kullanıyor (bkz. wasapi.rs).
//!
//! ## Satır sırası — iki kez ölçüldü (cv2, `--record-test`)
//!
//! `windows-capture`'ın MediaStreamSource tabanlı kodlayıcısı tamponu ALTTAN ÜSTE
//! okuyordu; ilk kayıt baş aşağı çıktı ve satırlar çevrilerek düzeltildi (1.000/0.111).
//! Kendi Sink Writer'ımıza geçince (ses için zorunlu) aynı çevirme görüntüyü yine baş
//! aşağı yaptı (−0.016/0.993): RGB32 + pozitif `MF_MT_DEFAULT_STRIDE` ÜSTTEN ALTA. WGC
//! de üstten alta verdiği için kare artık olduğu gibi yazılıyor, çevirme yok.

#![cfg(target_os = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use super::mf_writer::{AudioFormat, MfWriter, HNS_PER_SEC};
use super::wasapi;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type SharedWriter = Arc<Mutex<Option<MfWriter>>>;

/// Kırpma dikdörtgeni: monitöre göreli FİZİKSEL piksel.
#[derive(Clone, Copy)]
struct Crop {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

const FPS: u32 = 30;
const FRAME_DUR_HNS: i64 = HNS_PER_SEC / FPS as i64;

/// Yakalama thread'ine taşınan ayarlar.
struct Flags {
    /// Durdurma isteği: işleyici bir sonraki karede yakalamayı KENDİ kapatıyor
    /// (dışarıdan `CaptureControl::stop()` sonsuz döngüye girebiliyor — bkz. `stop`).
    stopping: Arc<AtomicBool>,
    writer: SharedWriter,
    crop: Crop,
    t0: i64,
    failed: Arc<Mutex<Option<String>>>,
    frames: Arc<AtomicU64>,
}

struct Handler {
    stopping: Arc<AtomicBool>,
    writer: SharedWriter,
    crop: Crop,
    t0: i64,
    last_sent: Option<Instant>,
    failed: Arc<Mutex<Option<String>>>,
    frames: Arc<AtomicU64>,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = BoxError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let f = ctx.flags;
        Ok(Self {
            stopping: f.stopping,
            writer: f.writer,
            crop: f.crop,
            t0: f.t0,
            last_sent: None,
            failed: f.failed,
            frames: f.frames,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Durdurma istendi: thread'i BURADAN bitir. Dışarıdan `CaptureControl::stop()`
        // yakalama thread'ine WM_QUIT yollayabilmek için döngüde bekliyor ve mesaj
        // kuyruğu yoksa çıkamıyor; içeriden bırakmak o riski atlıyor.
        if self.stopping.load(Ordering::Acquire) {
            control.stop();
            return Ok(());
        }
        // 30 fps'ye indir: WGC 60 kare/sn verebiliyor.
        let now = Instant::now();
        if let Some(last) = self.last_sent {
            if now.duration_since(last) < Duration::from_millis(1000 / FPS as u64) {
                return Ok(());
            }
        }

        // Kırpmayı kare sınırına sıkıştır (kayıt sırasında çözünürlük değişirse taşan
        // dikdörtgen D3D hatası verirdi). Boyut sabit kalmalı: yazıcı w×h bekliyor.
        let fw = frame.width();
        let fh = frame.height();
        let x0 = self.crop.x.min(fw.saturating_sub(self.crop.w));
        let y0 = self.crop.y.min(fh.saturating_sub(self.crop.h));
        let x1 = x0 + self.crop.w;
        let y1 = y0 + self.crop.h;
        if x1 > fw || y1 > fh {
            return Ok(());
        }

        let ts = (frame.timestamp().Duration - self.t0).max(0);
        let mut buf = frame.buffer_crop(x0, y0, x1, y1)?;
        let bytes = buf.as_nopadding_buffer()?;

        let w = self.crop.w as usize;
        let h = self.crop.h as usize;
        if bytes.len() < w * 4 * h {
            return Ok(());
        }
        // ⚠ Satır sırası — iki kez ölçüldü (cv2):
        // * `windows-capture`'ın kodlayıcısı (MediaStreamSource yolu) tamponu ALTTAN
        //   ÜSTE okuyordu; orada satırları çevirmek gerekmişti.
        // * Kendi Sink Writer'ımız RGB32 + pozitif `MF_MT_DEFAULT_STRIDE` ile ÜSTTEN
        //   ALTA okuyor; çevirince görüntü baş aşağı çıktı (normal −0.016 / çevrilmiş 0.993).
        // WGC de üstten alta veriyor, yani kare olduğu gibi yazılıyor.

        let mut guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = guard.as_mut() {
            if let Err(e) = w.write_video(bytes, ts, FRAME_DUR_HNS) {
                let msg = format!("kare yazılamadı: {e}");
                log::error!("kayıt: {msg}");
                *self.failed.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
                return Err(e.into());
            }
            self.frames.fetch_add(1, Ordering::Relaxed);
            self.last_sent = Some(now);
        }
        Ok(())
    }
}

pub struct Recording {
    control: Option<CaptureControl<Handler, BoxError>>,
    /// İşleyiciye "dur" bayrağı — nazik durdurma (bkz. `stop`).
    stopping: Arc<AtomicBool>,
    audio: Option<wasapi::AudioCapture>,
    writer: SharedWriter,
    failed: Arc<Mutex<Option<String>>>,
    frames: Arc<AtomicU64>,
    /// Kaydın yazıldığı geçici dosya. Kullanıcı kaydetmeyi iptal ederse yolu
    /// panoya gidiyor — kayıt kaybolmuyor.
    pub path: PathBuf,
    /// Bu monitörün penceresi; durdurmada diğer overlay'lerin kapatılması için.
    pub window_label: String,
}

#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<Recording>>);

/// Kalite kademesi → H.264 bit hızı.
fn bitrate_for(quality: &str) -> u32 {
    match quality {
        "ultra" => 16_000_000,
        "high" => 10_000_000,
        "medium" => 5_000_000,
        "low" => 2_500_000,
        _ => 10_000_000,
    }
}

/// Windows.Graphics.Capture bu makinede var mı? (Windows 10 1903+.) Crate API'yi
/// çalışma anında sorguluyor; eksikse `start` hata verir ve toast'a düşer.
pub fn is_supported() -> bool {
    true
}

/// Mantıksal monitör bilgisinden WGC monitörü: merkez noktasındaki HMONITOR.
fn wgc_monitor(monitor: &crate::geom::MonitorInfo) -> Result<Monitor, String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};

    let cx = ((monitor.x + monitor.width / 2.0) * monitor.scale).round() as i32;
    let cy = ((monitor.y + monitor.height / 2.0) * monitor.scale).round() as i32;
    // SAFETY: saf sorgu; geçersiz nokta için en yakın monitör döner.
    let h = unsafe { MonitorFromPoint(POINT { x: cx, y: cy }, MONITOR_DEFAULTTONEAREST) };
    if h.0.is_null() {
        return Err("monitör bulunamadı (HMONITOR null)".into());
    }
    Ok(Monitor::from_raw_hmonitor(h.0))
}

/// Kaydı başlatır. `crop_*` FİZİKSEL piksel, monitöre göreli.
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
    let wgc = wgc_monitor(monitor)?;

    // H.264 çift boyut ister.
    let even = |v: f64| (((v.max(2.0)) / 2.0).round() * 2.0) as u32;
    let crop = Crop {
        x: crop_x.max(0.0).round() as u32,
        y: crop_y.max(0.0).round() as u32,
        w: even(crop_w),
        h: even(crop_h),
    };

    let want_audio = capture_mic || capture_system_audio;
    let _ = std::fs::remove_file(&out_path);
    let writer = MfWriter::new(
        &out_path,
        crop.w,
        crop.h,
        FPS,
        bitrate_for(quality),
        want_audio.then_some(AudioFormat { sample_rate: wasapi::OUT_RATE, channels: wasapi::OUT_CHANNELS }),
    )?;
    let writer: SharedWriter = Arc::new(Mutex::new(Some(writer)));
    let failed = Arc::new(Mutex::new(None));
    let frames = Arc::new(AtomicU64::new(0));
    let t0 = wasapi::qpc_now_hns();

    // Ses: kaynak açılamazsa kayıt SESSİZ sürer (ses akışı boş kalır), kayıt düşmez.
    let audio = if want_audio {
        match wasapi::start(capture_mic, capture_system_audio, t0, writer.clone()) {
            Ok(a) => Some(a),
            Err(e) => {
                log::warn!("kayıt: ses açılamadı ({e}) — sessiz kaydediliyor");
                None
            }
        }
    } else {
        None
    };

    let stopping = Arc::new(AtomicBool::new(false));
    let make_flags = || Flags {
        stopping: stopping.clone(),
        writer: writer.clone(),
        crop,
        t0,
        failed: failed.clone(),
        frames: frames.clone(),
    };
    // Kenarlık YOK (Windows 11 / 10 20348+); daha eski Windows reddederse
    // varsayılanla (sarı çerçeve) yeniden denenir.
    let settings = |border: DrawBorderSettings, flags: Flags| {
        Settings::new(
            wgc,
            CursorCaptureSettings::WithCursor,
            border,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        )
    };

    let control = match Handler::start_free_threaded(settings(DrawBorderSettings::WithoutBorder, make_flags())) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("kayıt: kenarlıksız yakalama açılamadı ({e}), varsayılanla deneniyor");
            Handler::start_free_threaded(settings(DrawBorderSettings::Default, make_flags()))
                .map_err(|e| format!("ekran yakalama başlatılamadı: {e}"))?
        }
    };

    log::info!(
        "kayıt: {}x{} @{FPS}fps, kalite={quality} ({} kbps), ses={} → {}",
        crop.w,
        crop.h,
        bitrate_for(quality) / 1000,
        match (audio.is_some(), capture_mic, capture_system_audio) {
            (false, _, _) => "yok".to_string(),
            (true, true, true) => "mikrofon+sistem".to_string(),
            (true, true, false) => "mikrofon".to_string(),
            _ => "sistem".to_string(),
        },
        out_path.display()
    );

    Ok(Recording { control: Some(control), stopping, audio, writer, failed, frames, path: out_path, window_label })
}

impl Recording {
    /// Yakalamayı durdurur, sesi kapatır, yazıcıyı tamamlar (mux) ve dosya yolunu döner.
    pub fn stop(&mut self) -> Result<PathBuf, String> {
        // Üç aşama da bloklayıcı ve üçü de takılabilir; hangisinde olduğunu günlükten
        // okuyabilmek için her biri ayrı yazılıyor. (`windows-capture`nin `stop()`u
        // yakalama thread'ine WM_QUIT yollayana kadar DÖNGÜDE bekliyor — thread'in
        // mesaj kuyruğu yoksa orada kalınabilir.)
        let t = std::time::Instant::now();
        // 1) Kare akışını kes.
        //
        // ⚠ `CaptureControl::stop()` yakalama thread'ine WM_QUIT yollayana kadar
        // DÖNGÜDE bekliyor ve thread'in mesaj kuyruğu yoksa `ERROR_INVALID_THREAD_ID`
        // ile sonsuza dek dönebiliyor (crate'in kodu: `is_finished()` olmadıkça çıkmaz).
        // Bu yüzden önce NAZİK yol: işleyiciye "dur" diyoruz, o bir sonraki karede
        // `InternalCaptureControl::stop()` çağırıp thread'i kendi kendine bitiriyor.
        // Yarım saniyede bitmezse (statik ekranda hiç kare gelmeyebilir) eski yola düşülüyor.
        crate::capture::set_stop_phase(1);
        if let Some(control) = self.control.take() {
            log::info!("durdurma: yakalama kapatılıyor");
            self.stopping.store(true, Ordering::Release);
            for _ in 0..25 {
                if control.is_finished() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let graceful = control.is_finished();
            if let Err(e) = control.stop() {
                log::warn!("kayıt: yakalama durdurulurken: {e}");
            }
            log::info!(
                "durdurma: yakalama kapandı (+{} ms, {})",
                t.elapsed().as_millis(),
                if graceful { "nazik" } else { "WM_QUIT" }
            );
        }
        // 2) Ses thread'leri: karıştırıcı son parçayı yazıp çıkıyor.
        crate::capture::set_stop_phase(2);
        if let Some(audio) = self.audio.take() {
            log::info!("durdurma: ses kapatılıyor");
            audio.stop();
            log::info!("durdurma: ses kapandı (+{} ms)", t.elapsed().as_millis());
        }
        // 3) Yazıcıyı BİZ kapatıyoruz (işleyici içinde kapatmak statik ekranda hiç kare
        //    gelmezken sonsuza dek beklerdi).
        crate::capture::set_stop_phase(3);
        log::info!("durdurma: yazıcı kapatılıyor");
        let writer = self.writer.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(writer) = writer else { return Err("yazıcı zaten kapalı".into()) };
        let audio_samples = writer.audio_samples();
        // `IMFSinkWriter::Finalize()` donanım kodlayıcısını boşaltıyor; büyük kayıtlarda
        // uzun sürebiliyor, sürücü takılırsa hiç dönmeyebiliyor. Ayrı thread + GENİŞ bir
        // üst sınır: normal yolu kesmesin (çağıran zaten 12 sn'de oturumu bırakıp bizi
        // arka planda bekliyor), ama sonsuza dek de asılı kalmasın.
        let (tx, rx) = std::sync::mpsc::channel();
        let finalize_path = self.path.clone();
        std::thread::Builder::new()
            .name("copyboard-mux-finalize".into())
            .spawn(move || {
                let _ = tx.send(writer.finish());
            })
            .map_err(|e| format!("sonlandırma thread'i başlatılamadı: {e}"))?;
        let frames = match rx.recv_timeout(Duration::from_secs(300)) {
            Ok(r) => r?,
            Err(_) => {
                crate::capture::set_stop_phase(4);
                return Err(format!(
                    "video sonlandırılamadı: kodlayıcı 5 dakika yanıt vermedi. Ham kayıt: {}",
                    finalize_path.display()
                ));
            }
        };
        crate::capture::set_stop_phase(4);
        log::info!("durdurma: yazıcı kapandı (+{} ms)", t.elapsed().as_millis());
        if let Some(err) = self.failed.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Err(err);
        }
        let size = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        log::info!(
            "kayıt bitti: {frames} kare, {:.1} sn ses, {:.2} MB",
            audio_samples as f64 / (wasapi::OUT_RATE as f64 * wasapi::OUT_CHANNELS as f64),
            size as f64 / 1_048_576.0
        );
        let _ = self.frames.load(Ordering::Relaxed);
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
    fn kalite_bit_hizina_donusuyor() {
        assert!(bitrate_for("ultra") > bitrate_for("high"));
        assert!(bitrate_for("high") > bitrate_for("medium"));
        assert!(bitrate_for("medium") > bitrate_for("low"));
        assert_eq!(bitrate_for("bilinmeyen"), bitrate_for("high"));
    }

    #[test]
    fn qpc_saati_ilerliyor() {
        let a = wasapi::qpc_now_hns();
        std::thread::sleep(Duration::from_millis(5));
        let b = wasapi::qpc_now_hns();
        assert!(b > a, "QPC ilerlemedi");
        assert!(b - a < HNS_PER_SEC, "5 ms bekleme 1 sn'den uzun ölçüldü");
    }
}
