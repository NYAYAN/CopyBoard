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

/// Donanım (GPU) H.264 kodlayıcısı kullanılsın mı? Varsayılan KAPALI.
///
/// ## Neden kapalı — ölçüm (A14, 9. bildirim, 3 monitörlü makine, 2026-09-10)
///
/// O makinede donanım kodlayıcısı MFT'si girdiyi HİÇ tüketmiyor. 3 dakikalık ultra
/// kayıtta çıkış dosyasına TEK BAYT düşmedi (0 bayt), buna karşılık ~4300 ham BGRA kare
/// yazıcının kuyruğunda birikti (süreç 20 GB) ve `Finalize()` o kuyruğun boşalmasını
/// bekleyerek hiç dönmedi. Yani sorun sanıldığı gibi "yavaş sonlandırma" değil,
/// kodlayıcının hiç çalışmaması: sonlandırma sadece bunun görüldüğü yer.
///
/// Aynı makinede yazılım kodlayıcısı sorunsuz (10 sn kayıt, 188 kare, sonlandırma
/// 402 ms). Bedeli CPU; karşılığında kayıt gerçekten oluyor.
///
/// `COPYBOARD_HARDWARE_ENCODER=1` GPU yolunu geri açar (yeni sürücüde sınamak için);
/// `COPYBOARD_SOFTWARE_ENCODER` her koşulda kapatır. GPU yolu açıkken sonlandırma ya da
/// bekçi düşerse [`set_hardware_encoder(false)`] o oturumda bir daha denemiyor.
///
/// Bayrağın kendisi "GPU yolu bu oturumda DÜŞMEDİ mi?" sorusunu tutuyor (o yüzden
/// başlangıç değeri `true`); yolun açık olup olmadığına [`hardware_requested`] ile
/// birlikte karar veriliyor — ortam değişkeni verilmedikçe kapalı.
static HARDWARE_ENCODER: AtomicBool = AtomicBool::new(true);

/// Ortam değişkeni GPU yolunu istiyor mu? Bir kez okunuyor.
fn hardware_requested() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        std::env::var("COPYBOARD_SOFTWARE_ENCODER").is_err()
            && std::env::var("COPYBOARD_HARDWARE_ENCODER").is_ok_and(|v| v != "0")
    })
}

pub fn set_hardware_encoder(on: bool) {
    HARDWARE_ENCODER.store(on, Ordering::Release);
}

pub fn hardware_encoder() -> bool {
    hardware_requested() && HARDWARE_ENCODER.load(Ordering::Acquire)
}

// ── Kodlayıcı bekçisi eşikleri ──────────────────────────────────────────────────
//
// Tıkanan kodlayıcı İKİ FARKLI biçimde görülüyor ve tek bir ölçüt ikisini birden
// yakalamıyor; ölçüldü (2026-09-10, aynı makine):
//
// * BLOKLAYAN kip — `WriteSample` hiç dönmüyor (throttling kuyruğu doldu). WGC
//   işleyicisi orada duruyor, kare sayacı da DONUYOR: 45 sn'lik denemede sayaç 56'da
//   kaldı. Kare sayısına bakan bir bekçi tam da yakalaması gereken yerde uyumuyordu.
// * KUYRUKLAYAN kip — `WriteSample` hemen dönüyor ama kodlayıcı hiç tüketmiyor; her
//   kare ham BGRA olarak bellekte birikiyor. Kullanıcıda 3 dakikada 20 GB oldu ve
//   dosyaya tek bayt düşmedi.
//
// Bu yüzden iki ayrı ölçüt var. Dosya boyutunun tek başına ölçüt OLMADIĞINA dikkat:
// ekran hareketsizken WGC hiç kare vermiyor, dolayısıyla 0 bayt SAĞLIKLI olabiliyor —
// ilk denemede bekçi tam da bunu yanlış alarma çevirip sağlam kaydı silmişti.

/// Süregelen tek bir `WriteSample` bu kadar sürerse kodlayıcı bloklamış demektir.
/// Sağlıklı yolda milisaniyeler sürüyor.
const STALL_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Dosya HİÇ büyümezken yazıcıya bu kadar kare daha verilmişse kodlayıcı kuyruklayıp
/// hiç tüketmiyor demektir. 300 kare ≈ 10 sn hareketli içerik; sağlıklı yolda o kadar
/// karenin tek baytı bile yazılmamış olamaz (ölçüm: 2 karede 143 KB, ses varsa +250 ms'de
/// başlık). Biriken ham kare 880x720'de ~750 MB, 2560x1440'ta ~4 GB — 20 GB yerine.
const STALL_FRAMES: u64 = 300;

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
    writing_since: Arc<AtomicU64>,
    clock: Instant,
}

struct Handler {
    stopping: Arc<AtomicBool>,
    writer: SharedWriter,
    crop: Crop,
    t0: i64,
    last_sent: Option<Instant>,
    failed: Arc<Mutex<Option<String>>>,
    frames: Arc<AtomicU64>,
    /// Süregelen `WriteSample`ın başlama anı (`clock`ten beri ms, +1; 0 = yazma yok).
    /// Bekçi bloklayan kodlayıcıyı buradan görüyor (bkz. [`STALL_WRITE_TIMEOUT`]).
    writing_since: Arc<AtomicU64>,
    /// Bekçiyle PAYLAŞILAN tek saat: `Instant` atomiğe sığmıyor, ikisi de aynı
    /// başlangıca göre ms cinsinden ölçüyor.
    clock: Instant,
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
            writing_since: f.writing_since,
            clock: f.clock,
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
            // Sayaç ve saat yazmadan ÖNCE işaretleniyor: kodlayıcı bloklarsa
            // `write_video` hiç dönmüyor ve bekçinin görebileceği tek iz bu.
            self.frames.fetch_add(1, Ordering::Relaxed);
            self.writing_since
                .store(self.clock.elapsed().as_millis() as u64 + 1, Ordering::Release);
            let wrote = w.write_video(bytes, ts, FRAME_DUR_HNS);
            self.writing_since.store(0, Ordering::Release);
            if let Err(e) = wrote {
                let msg = format!("kare yazılamadı: {e}");
                log::error!("kayıt: {msg}");
                *self.failed.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
                return Err(e.into());
            }
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
    /// Yazıcıya VERİLEN kare sayısı (yazılabildiği değil — bkz. `on_frame_arrived`).
    /// Yalnız bekçi ve günlük için; kesin sayı `MfWriter::video_frames()`.
    frames: Arc<AtomicU64>,
    /// Bekçi kodlayıcının tüketmediğini gördü mü? Görmüşse `stop` sonlandırmayı
    /// (`Finalize`) HİÇ denemiyor — o çağrı dönmüyor (bkz. [`STALL_FRAMES`]).
    stalled: Arc<AtomicBool>,
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
    // Ortak çağıranla (`commands/record.rs`) imza uyumu için alınıyor. macOS'ta
    // mikrofon aygıtı ScreenCaptureKit'e UID ile veriliyor; Windows'ta WASAPI
    // yakalama henüz varsayılan aygıtı kullanıyor ve bu değer UYGULANMIYOR.
    // Parametre burada durmasaydı Windows derlemesi kırılırdı (kırıldı da —
    // macOS tarafına eklenip burası unutulmuştu).
    _mic_device: &str,
    // Aynı imza uyumu: macOS'ta yakalama overlay'leri ScreenCaptureKit filtresinden
    // CGWindowID ile çıkarılıyor. Windows'ta overlay `WDA_EXCLUDEFROMCAPTURE` ile
    // zaten karelere hiç girmiyor, bu yüzden liste UYGULANMIYOR.
    _exclude_window_ids: &[u32],
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
        hardware_encoder(),
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
    let writing_since = Arc::new(AtomicU64::new(0));
    let clock = Instant::now();
    let make_flags = || Flags {
        stopping: stopping.clone(),
        writer: writer.clone(),
        crop,
        t0,
        failed: failed.clone(),
        frames: frames.clone(),
        writing_since: writing_since.clone(),
        clock,
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

    // ── Kodlayıcı bekçisi ────────────────────────────────────────────────────────
    // Kodlayıcı girdiyi tüketmediğinde `Finalize()` kuyruğu bekleyip hiç dönmüyor ve
    // kullanıcı tarafında bu "durdur → hiçbir şey olmuyor" oluyordu (A14). Bekçi durumu
    // 10 saniyede yakalıyor: kare akışını kesiyor ve `stop`a sonlandırmayı hiç
    // denememesini söylüyor — 3 dakika RAM dolmuyor, hata durdurmada anlaşılır çıkıyor.
    // İki ölçütün neden gerektiği: bkz. [`STALL_WRITE_TIMEOUT`] / [`STALL_FRAMES`].
    let stalled = Arc::new(AtomicBool::new(false));
    {
        let (stopping, failed, frames, stalled, writing_since) = (
            stopping.clone(),
            failed.clone(),
            frames.clone(),
            stalled.clone(),
            writing_since.clone(),
        );
        let path = out_path.clone();
        let spawned = std::thread::Builder::new()
            .name("copyboard-encoder-watchdog".into())
            .spawn(move || {
                // Dosyanın büyüdüğü son an: (boyut, o boyutta verilmiş kare sayısı).
                let mut mark = (0u64, 0u64);
                let mut logged_first_byte = false;
                loop {
                    std::thread::sleep(Duration::from_millis(250));
                    if stopping.load(Ordering::Acquire) {
                        return;
                    }
                    let n = frames.load(Ordering::Relaxed);
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    if size > 0 && !logged_first_byte {
                        logged_first_byte = true;
                        log::info!(
                            "kayıt: kodlayıcı yazmaya başladı (+{} ms, {n} kare, {size} bayt)",
                            clock.elapsed().as_millis()
                        );
                    }

                    // (a) BLOKLAYAN kip: tek bir `WriteSample` dönmüyor.
                    let since = writing_since.load(Ordering::Acquire);
                    let blocked_ms = if since > 0 {
                        (clock.elapsed().as_millis() as u64).saturating_sub(since - 1)
                    } else {
                        0
                    };
                    // (b) KUYRUKLAYAN kip: dosya büyümezken kareler akmayı sürdürüyor.
                    if size != mark.0 {
                        mark = (size, n);
                    }
                    let starved = n.saturating_sub(mark.1) >= STALL_FRAMES;

                    if blocked_ms >= STALL_WRITE_TIMEOUT.as_millis() as u64 || starved {
                        let neden = if starved {
                            format!("{} kare verildi, dosya {size} baytta duruyor", n - mark.1)
                        } else {
                            format!("tek kare yazımı {blocked_ms} ms'dir dönmedi")
                        };
                        let msg = format!(
                            "kodlayıcı veri yazmıyor: {neden} ({} kodlayıcısı)",
                            if hardware_encoder() { "donanım" } else { "yazılım" }
                        );
                        log::error!("kayıt: {msg}");
                        *failed.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
                        stalled.store(true, Ordering::Release);
                        // Kare akışını KES: işleyici bir sonraki karede yakalamayı bitiriyor.
                        stopping.store(true, Ordering::Release);
                        return;
                    }
                }
            });
        if let Err(e) = spawned {
            log::warn!("kayıt: kodlayıcı bekçisi başlatılamadı: {e}");
        }
    }

    log::info!(
        "kayıt: {}x{} @{FPS}fps, kalite={quality} ({} kbps), kodlayıcı={}, ses={} → {}",
        crop.w,
        crop.h,
        bitrate_for(quality) / 1000,
        if hardware_encoder() { "donanım" } else { "yazılım" },
        match (audio.is_some(), capture_mic, capture_system_audio) {
            (false, _, _) => "yok".to_string(),
            (true, true, true) => "mikrofon+sistem".to_string(),
            (true, true, false) => "mikrofon".to_string(),
            _ => "sistem".to_string(),
        },
        out_path.display()
    );

    Ok(Recording {
        control: Some(control),
        stopping,
        audio,
        writer,
        failed,
        frames,
        stalled,
        path: out_path,
        window_label,
    })
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

        // Bekçi kodlayıcının tüketmediğini gördüyse `Finalize()` kuyruğun boşalmasını
        // bekler ve DÖNMEZ; `Drop` da `Finalize` çağırdığı için yazıcıyı düşürmek de
        // aynı yere kilitlenir. Bu yüzden sonlandırılmadan bırakılıyor.
        if self.stalled.load(Ordering::Acquire) {
            writer.discard();
            // Dosya 0 bayt: elde kalan bir kayıt yok, geride çöp bırakmayalım.
            let _ = std::fs::remove_file(&self.path);
            crate::capture::set_stop_phase(4);
            let msg = self
                .failed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .unwrap_or_else(|| "kodlayıcı veri yazmıyor".into());
            log::error!("durdurma: {msg} — yazıcı sonlandırılmadan bırakıldı");
            return Err(msg);
        }

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
        // 60 sn: sağlıklı yolda 60 sn'lik kayıt ~1,3 sn'de sonlanıyor (QA 25). Takılan
        // kodlayıcı ise HİÇ dönmüyor — daha uzun beklemek kullanıcıya bir şey
        // kazandırmıyor, yalnız hatayı geciktiriyordu (eski sınır 5 dakikaydı).
        let frames = match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(r) => r?,
            Err(_) => {
                crate::capture::set_stop_phase(4);
                return Err(format!(
                    "video sonlandırılamadı: kodlayıcı 60 sn yanıt vermedi. Ham kayıt: {}",
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

    /// A14: donanım H.264 kodlayıcısı bazı makinelerde girdiyi HİÇ tüketmiyor
    /// (0 baytlık dosya + 20 GB kuyruk + dönmeyen `Finalize`). Varsayılan YAZILIM
    /// olmalı; GPU yolu yalnız ortam değişkeniyle açılıyor.
    #[test]
    fn varsayilan_kodlayici_yazilim() {
        if std::env::var("COPYBOARD_HARDWARE_ENCODER").is_ok() {
            return; // testi bilerek GPU yoluyla koşan geliştirici için anlamsız
        }
        assert!(!hardware_encoder(), "donanım kodlayıcısı varsayılan olarak açık");
        // Başarısızlıkta oturum boyunca kapalı kalıyor.
        set_hardware_encoder(false);
        assert!(!hardware_encoder());
    }

    #[test]
    fn bekci_esikleri_saglikli_yola_pay_birakiyor() {
        // Ölçüm: sağlıklı yolda ilk bayt +835 ms'de düştü, sonlandırma 323 ms sürdü.
        assert!(STALL_WRITE_TIMEOUT >= Duration::from_secs(5));
        assert!(STALL_FRAMES >= 240, "10 sn'lik hareketli içerikten az eşik yanlış alarm verir");
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
