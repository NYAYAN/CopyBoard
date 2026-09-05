//! `AVAssetWriter` sarmalayıcısı — bit hızı denetimli H.264 yazıcı.
//!
//! ## Neden `SCRecordingOutput` bırakıldı
//!
//! `SCRecordingOutput` encode ve mux'u kendi içinde yapıyor ve **bit hızı ayarı
//! sunmuyor** — `SCRecordingOutputConfiguration`ın tamamı üç şeyden ibaret: çıktı
//! URL'i, kodek, dosya türü. Ölçüldü (BULGU R-19): sıkıştırılamaz gürültü kaydederken
//! bile 1280×720@54fps'te **10 Mbps**'te, kare başına 49 KB'ta tıkanıyor. Yani bu bir
//! içerik sınırı değil, Apple'ın sabit bütçesi.
//!
//! Electron `videoBitsPerSecond` veriyordu: ultra 50, high 25, medium 10, low 5 Mbps.
//! Metin içeren ekran kaydında net görüntü ~0,30–0,50 bit/piksel ister; tavan bizi
//! 0,21'de tutuyordu, yani yazılar harekette yumuşuyordu.
//!
//! Bu modül kareleri `SCStream`den alıp `AVAssetWriter` ile kendimiz yazıyor —
//! `AVVideoAverageBitRateKey` ile Electron'daki hedefler geri geliyor.
//!
//! ## Thread kuralı
//!
//! `SCStream` görüntü ve sesi AYRI dispatch kuyruklarından teslim ediyor. AVFoundation
//! farklı `AVAssetWriterInput`lara farklı thread'lerden eklemeye izin veriyor, ama AYNI
//! input'a eş zamanlı ekleme yapılamaz. Her input kendi `Mutex`i altında; böylece kural
//! tip düzeyinde garanti altında.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus,
    AVFileTypeMPEG4, AVMediaTypeAudio,
    AVMediaTypeVideo, AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeH264,
    AVVideoCompressionPropertiesKey, AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey,
    AVVideoMaxKeyFrameIntervalKey, AVVideoProfileLevelH264HighAutoLevel, AVVideoProfileLevelKey,
    AVVideoWidthKey,
};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::CVPixelBuffer;

// CoreVideo'nun düzlem erişimcileri `objc2-core-video` 0.3.2'de bağlanmamış; C
// imzaları burada. Hepsi CoreVideo.framework'ten geliyor ve ABI'leri sabit.
#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferGetPlaneCount(pb: *mut std::ffi::c_void) -> usize;
    fn CVPixelBufferGetBaseAddressOfPlane(pb: *mut std::ffi::c_void, plane: usize) -> *mut u8;
    fn CVPixelBufferGetBytesPerRowOfPlane(pb: *mut std::ffi::c_void, plane: usize) -> usize;
    fn CVPixelBufferGetHeightOfPlane(pb: *mut std::ffi::c_void, plane: usize) -> usize;
    fn CVPixelBufferGetWidthOfPlane(pb: *mut std::ffi::c_void, plane: usize) -> usize;
    fn CVPixelBufferGetBaseAddress(pb: *mut std::ffi::c_void) -> *mut u8;
    fn CVPixelBufferGetBytesPerRow(pb: *mut std::ffi::c_void) -> usize;
    fn CVPixelBufferGetHeight(pb: *mut std::ffi::c_void) -> usize;
    fn CVPixelBufferGetWidth(pb: *mut std::ffi::c_void) -> usize;
    fn CVPixelBufferLockBaseAddress(pb: *mut std::ffi::c_void, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(pb: *mut std::ffi::c_void, flags: u64) -> i32;
    fn CVPixelBufferPoolCreatePixelBuffer(
        allocator: *const std::ffi::c_void,
        pool: *mut std::ffi::c_void,
        out: *mut *mut std::ffi::c_void,
    ) -> i32;
    fn CFRelease(cf: *mut std::ffi::c_void);
}

const K_CV_READ_ONLY: u64 = 0x0000_0001;

/// Bir piksel tamponunun içeriğini diğerine kopyalar.
///
/// ## Neden kopyalıyoruz
///
/// `appendPixelBuffer` ScreenCaptureKit'in HAVUZ tamponunu alıkoyuyor ve oturum
/// boyunca bırakmıyor. Havuzda `queueDepth` kadar tampon var; hepsi kodlayıcıda
/// kalınca akış duruyor. Ölçüm bunu birebir gösterdi: derinlik 8 → 8 kare,
/// derinlik 32 → 32 kare, sonra sıfır. Kareyi kendi tamponumuza kopyalayınca
/// kaynak hemen serbest kalıyor ve akış kesintisiz sürüyor.
///
/// # Safety
/// İki tampon da geçerli olmalı ve aynı biçim/boyutta olmalı.
unsafe fn copy_pixel_buffer(src: *mut std::ffi::c_void, dst: *mut std::ffi::c_void) -> bool {
    unsafe {
        if CVPixelBufferLockBaseAddress(src, K_CV_READ_ONLY) != 0 {
            return false;
        }
        if CVPixelBufferLockBaseAddress(dst, 0) != 0 {
            CVPixelBufferUnlockBaseAddress(src, K_CV_READ_ONLY);
            return false;
        }

        let planes = CVPixelBufferGetPlaneCount(src);
        let ok = if planes == 0 {
            // Paketlenmiş biçim (BGRA gibi): tek blok.
            copy_plane(
                CVPixelBufferGetBaseAddress(src),
                CVPixelBufferGetBytesPerRow(src),
                CVPixelBufferGetBaseAddress(dst),
                CVPixelBufferGetBytesPerRow(dst),
                CVPixelBufferGetHeight(src).min(CVPixelBufferGetHeight(dst)),
                CVPixelBufferGetWidth(src).min(CVPixelBufferGetWidth(dst)) * 4,
            )
        } else {
            // Düzlemli biçim (420v: Y + CbCr). Satır uzunlukları farklı olabilir,
            // o yüzden satır satır ve iki taraftan KÜÇÜK olanı kadar kopyalanıyor.
            (0..planes).all(|i| {
                copy_plane(
                    CVPixelBufferGetBaseAddressOfPlane(src, i),
                    CVPixelBufferGetBytesPerRowOfPlane(src, i),
                    CVPixelBufferGetBaseAddressOfPlane(dst, i),
                    CVPixelBufferGetBytesPerRowOfPlane(dst, i),
                    CVPixelBufferGetHeightOfPlane(src, i).min(CVPixelBufferGetHeightOfPlane(dst, i)),
                    CVPixelBufferGetWidthOfPlane(src, i).min(CVPixelBufferGetWidthOfPlane(dst, i)),
                )
            })
        };

        CVPixelBufferUnlockBaseAddress(dst, 0);
        CVPixelBufferUnlockBaseAddress(src, K_CV_READ_ONLY);
        ok
    }
}

/// # Safety
/// İşaretçiler geçerli ve verilen ölçülere uygun olmalı.
unsafe fn copy_plane(
    src: *const u8,
    src_stride: usize,
    dst: *mut u8,
    dst_stride: usize,
    rows: usize,
    row_bytes: usize,
) -> bool {
    if src.is_null() || dst.is_null() {
        return false;
    }
    let n = row_bytes.min(src_stride).min(dst_stride);
    for r in 0..rows {
        unsafe {
            std::ptr::copy_nonoverlapping(src.add(r * src_stride), dst.add(r * dst_stride), n);
        }
    }
    true
}
use objc2::runtime::AnyObject;
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

/// Kalite kademesi → hedef bit hızı (bit/sn). Electron'daki değerlerin aynısı.
///
/// | Kademe | Bit hızı |
/// |---|---|
/// | ultra  | 50 Mbps |
/// | high   | 25 Mbps |
/// | medium | 10 Mbps |
/// | low    |  5 Mbps |
pub fn quality_bitrate(quality: &str) -> u32 {
    match quality {
        "ultra" => 50_000_000,
        "medium" => 10_000_000,
        "low" => 5_000_000,
        _ => 25_000_000, // high ve bilinmeyen
    }
}

pub struct AssetWriter {
    writer: Retained<AVAssetWriter>,
    video: Mutex<Retained<AVAssetWriterInput>>,
    /// Kareler örnek tamponu olarak DEĞİL, piksel tamponu olarak veriliyor.
    ///
    /// `appendSampleBuffer` ile ScreenCaptureKit tamponunu doğrudan vermek ilk kareyi
    /// geçiriyor, sonra kodlayıcı asenkron çöküyordu (-16122) ve yazıcı `Failed`
    /// durumuna düşüp kalan her kareyi reddediyordu. Ayarları, bit hızını, piksel
    /// biçimini ve zamanlamayı tek tek eleyerek bulundu: sorun örnek tamponunun
    /// KENDİSİNDE (ekran yakalamaya özgü biçim tanımı taşıyor). Adaptör yolu yalnız
    /// piksel tamponunu ve zaman damgasını alıyor — Apple'ın ekran kaydı için
    /// belgelediği yol da bu.
    adaptor: Mutex<Retained<AVAssetWriterInputPixelBufferAdaptor>>,
    /// TEK ses izi.
    ///
    /// Mikrofon ve sistem sesi ayrı izlere yazmak denendi: dosya bozulmuyordu ama
    /// VLC gibi oynatıcılar yalnız ilk izi çaldığı için paylaşılan kayıtta mikrofon
    /// duyulmuyordu. İki kaynağı AYNI girdiye ham hâlde yazmak ise (biçimleri farklı
    /// olduğu için) -12737 ile kaydı komple bozuyordu. Şimdi kaynaklar
    /// [`crate::capture::mixer`] ile PCM düzeyinde karıştırılıp tek iz olarak
    /// yazılıyor.
    audio: Option<Mutex<Retained<AVAssetWriterInput>>>,
    /// `startSessionAtSourceTime` ilk GÖRÜNTÜ karesiyle çağrılıyor; ondan önce gelen
    /// ses örnekleri atılmalı, yoksa yazıcı hata veriyor.
    session_started: AtomicBool,
    video_frames: AtomicU64,
    dropped: AtomicU64,
    audio_samples: AtomicU64,
    audio_dropped: AtomicU64,
}

// SAFETY: AVAssetWriter ve AVAssetWriterInput, Apple tarafından farklı input'lara
// farklı thread'lerden ekleme yapılabilecek şekilde belgelendi. Aynı input'a eş zamanlı
// erişim `Mutex` ile engelleniyor; `writer` üzerinde yalnız durum okuma ve
// başlat/bitir çağrıları var, onlar da bu tipin metotlarında sıralanıyor.
unsafe impl Send for AssetWriter {}
unsafe impl Sync for AssetWriter {}

impl AssetWriter {
    /// Yazıcıyı kurar. `path` YOKSA oluşturulur; varsa `AVAssetWriter` hata verir,
    /// bu yüzden çağıran önce silmeli.
    pub fn new(
        path: &std::path::Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        with_audio: bool,
    ) -> Result<Self, String> {
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            let file_type = AVFileTypeMPEG4.ok_or("AVFileTypeMPEG4 yok")?;
            let writer = AVAssetWriter::initWithURL_fileType_error(
                AVAssetWriter::alloc(),
                &url,
                file_type,
            )
            .map_err(|e| format!("AVAssetWriter oluşturulamadı: {e:?}"))?;

            // ── Sıkıştırma ayarları ──────────────────────────────────────────
            // `AVVideoExpectedSourceFrameRateKey` ve `MaxKeyFrameInterval` olmadan
            // kodlayıcı kare hızını tahmin etmeye çalışıyor ve bit hızı bütçesini
            // yanlış dağıtıyor. Anahtar kare aralığı = 2 sn: aramayı makul tutuyor,
            // her karede anahtar kare üretip bit hızını yakmıyor.
            let n_bitrate = NSNumber::new_u32(bitrate);
            let n_fps = NSNumber::new_u32(fps);
            let n_keyint = NSNumber::new_u32(fps * 2);
            // ── AVVideoProfileLevelKey ŞART ──────────────────────────────────
            // Varsayılan H.264 profili/seviyesi bit hızına bir TAVAN koyuyor
            // (Level 3.1 ≈ 14 Mbps). 50 Mbps istendiğinde kodlayıcı ilk kareden
            // sonra çöküyor: yazıcı `Failed` durumuna düşüyor, sonraki her ekleme
            // reddediliyor ve kayıt 1 karede kalıyor — ölçülen tam olarak buydu.
            // `HighAutoLevel` seviyeyi istenen bit hızına göre kendisi seçiyor.
            let profile = AVVideoProfileLevelH264HighAutoLevel
                .ok_or("AVVideoProfileLevelH264HighAutoLevel yok")?;
            let compression: Retained<NSDictionary<NSString, AnyObject>> =
                NSDictionary::from_slices(
                    &[
                        AVVideoAverageBitRateKey.ok_or("AVVideoAverageBitRateKey yok")?,
                        AVVideoExpectedSourceFrameRateKey
                            .ok_or("AVVideoExpectedSourceFrameRateKey yok")?,
                        AVVideoMaxKeyFrameIntervalKey.ok_or("AVVideoMaxKeyFrameIntervalKey yok")?,
                        AVVideoProfileLevelKey.ok_or("AVVideoProfileLevelKey yok")?,
                    ],
                    &[
                        n_bitrate.as_ref() as &AnyObject,
                        n_fps.as_ref() as &AnyObject,
                        n_keyint.as_ref() as &AnyObject,
                        profile as &NSString as &AnyObject,
                    ],
                );

            let codec = AVVideoCodecTypeH264.ok_or("AVVideoCodecTypeH264 yok")?;
            let n_w = NSNumber::new_u32(width);
            let n_h = NSNumber::new_u32(height);
            let settings: Retained<NSDictionary<NSString, AnyObject>> =
                NSDictionary::from_slices(
                    &[
                        AVVideoCodecKey.ok_or("AVVideoCodecKey yok")?,
                        AVVideoWidthKey.ok_or("AVVideoWidthKey yok")?,
                        AVVideoHeightKey.ok_or("AVVideoHeightKey yok")?,
                        AVVideoCompressionPropertiesKey
                            .ok_or("AVVideoCompressionPropertiesKey yok")?,
                    ],
                    &[
                        codec as &NSString as &AnyObject,
                        n_w.as_ref() as &AnyObject,
                        n_h.as_ref() as &AnyObject,
                        compression.as_ref() as &AnyObject,
                    ],
                );

            let media_video = AVMediaTypeVideo.ok_or("AVMediaTypeVideo yok")?;
            let video = AVAssetWriterInput::initWithMediaType_outputSettings(
                AVAssetWriterInput::alloc(),
                media_video,
                Some(&settings),
            );
            // Canlı kaynak: yazıcı kareleri geldikleri hızda kabul etmeli, tamponlamamalı.
            video.setExpectsMediaDataInRealTime(true);
            if !writer.canAddInput(&video) {
                return Err("görüntü girdisi eklenemiyor".into());
            }
            writer.addInput(&video);

            // Kaynak nitelikleri ŞART: adaptör bunlarla KENDİ tampon havuzunu kuruyor.
            // Kareler oraya kopyalanıp öyle veriliyor; ScreenCaptureKit'in tamponu
            // hemen serbest kalıyor (bkz. `copy_pixel_buffer`).
            //
            // kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange — akışın biçimiyle aynı
            // olmalı, yoksa kopyalama düzlem sayısı uyuşmaz.
            const K_420V: u32 = 0x3432_3076; // '420v'
            let pf = NSNumber::new_u32(K_420V);
            let pw = NSNumber::new_u32(width);
            let ph = NSNumber::new_u32(height);
            let src_attrs: Retained<NSDictionary<NSString, AnyObject>> =
                NSDictionary::from_slices(
                    &[
                        &*NSString::from_str("PixelFormatType"),
                        &*NSString::from_str("Width"),
                        &*NSString::from_str("Height"),
                    ],
                    &[
                        pf.as_ref() as &AnyObject,
                        pw.as_ref() as &AnyObject,
                        ph.as_ref() as &AnyObject,
                    ],
                );
            let adaptor = AVAssetWriterInputPixelBufferAdaptor::
                assetWriterInputPixelBufferAdaptorWithAssetWriterInput_sourcePixelBufferAttributes(
                    &video, Some(&src_attrs),
                );

            // ── Ses ──────────────────────────────────────────────────────────
            // Ayar sözlüğü ŞART. İlk deneme `None` (passthrough) ile yapıldı ve
            // `canAddInput` reddetti: ScreenCaptureKit sesi ham PCM veriyor, MP4 ise
            // ham PCM taşımıyor — yani encode edilmesi gerekiyor.
            //
            // Anahtarlar elle yazılıyor çünkü `objc2-av-foundation` bunları statik
            // olarak dışa açmıyor. AVFoundation'da bu sabitlerin DEĞERİ adlarıyla
            // birebir aynı ("AVFormatIDKey" == @"AVFormatIDKey"), o yüzden güvenli.
            let make_audio_input = |name: &str| -> Result<Option<Mutex<Retained<AVAssetWriterInput>>>, String> {
                let media_audio = AVMediaTypeAudio.ok_or("AVMediaTypeAudio yok")?;
                // kAudioFormatMPEG4AAC — CoreAudioTypes'ta 'aac ' dört harfli kodu.
                const K_AUDIO_FORMAT_MPEG4_AAC: u32 = 0x6161_6320;
                let a_fmt = NSNumber::new_u32(K_AUDIO_FORMAT_MPEG4_AAC);
                let a_ch = NSNumber::new_u32(2);
                let a_rate = NSNumber::new_f64(48_000.0);
                let a_br = NSNumber::new_u32(128_000);
                let audio_settings: Retained<NSDictionary<NSString, AnyObject>> =
                    NSDictionary::from_slices(
                        &[
                            &*NSString::from_str("AVFormatIDKey"),
                            &*NSString::from_str("AVNumberOfChannelsKey"),
                            &*NSString::from_str("AVSampleRateKey"),
                            &*NSString::from_str("AVEncoderBitRateKey"),
                        ],
                        &[
                            a_fmt.as_ref() as &AnyObject,
                            a_ch.as_ref() as &AnyObject,
                            a_rate.as_ref() as &AnyObject,
                            a_br.as_ref() as &AnyObject,
                        ],
                    );
                let input = AVAssetWriterInput::initWithMediaType_outputSettings(
                    AVAssetWriterInput::alloc(),
                    media_audio,
                    Some(&audio_settings),
                );
                input.setExpectsMediaDataInRealTime(true);
                if writer.canAddInput(&input) {
                    writer.addInput(&input);
                    Ok(Some(Mutex::new(input)))
                } else {
                    log::warn!("{name} ses girdisi eklenemedi — o kaynak sessiz kalacak");
                    Ok(None)
                }
            };
            let audio = if with_audio { make_audio_input("ses")? } else { None };

            if !writer.startWriting() {
                return Err(format!("yazma başlatılamadı: {:?}", writer.error()));
            }

            log::info!(
                "AVAssetWriter: {width}x{height} @{fps}fps, {:.1} Mbps, ses={}",
                f64::from(bitrate) / 1e6,
                audio.is_some()
            );

            Ok(Self {
                writer,
                video: Mutex::new(video),
                adaptor: Mutex::new(adaptor),
                audio,
                session_started: AtomicBool::new(false),
                video_frames: AtomicU64::new(0),
                dropped: AtomicU64::new(0),
                audio_samples: AtomicU64::new(0),
                audio_dropped: AtomicU64::new(0),
            })
        }
    }

    /// Ham `CMSampleBufferRef`i güvenli referansa çevirir.
    ///
    /// # Safety
    /// `ptr` geçerli, canlı bir `CMSampleBufferRef` olmalı. Çağıran, referansın
    /// kullanıldığı süre boyunca tamponun serbest bırakılmayacağını garanti etmeli —
    /// `SCStream` geri çağrısı içinde bu doğru.
    unsafe fn as_sample(ptr: *mut std::ffi::c_void) -> Option<&'static CMSampleBuffer> {
        if ptr.is_null() {
            return None;
        }
        Some(unsafe { &*ptr.cast::<CMSampleBuffer>() })
    }

    /// Bir görüntü karesi ekler. İlk kare oturumu başlatır.
    ///
    /// # Safety
    /// `ptr` geçerli bir `CMSampleBufferRef` olmalı.
    pub unsafe fn append_video(&self, ptr: *mut std::ffi::c_void, pts: objc2_core_media::CMTime) {
        if ptr.is_null() {
            return;
        }
        let pixels: &CVPixelBuffer = unsafe { &*ptr.cast::<CVPixelBuffer>() };

        // Oturum İLK GÖRÜNTÜ karesinin zaman damgasıyla başlıyor. Ses önce gelirse
        // atılıyor: `startSession` öncesi ekleme yazıcıyı hata durumuna düşürür.
        if !self.session_started.swap(true, Ordering::AcqRel) {
            unsafe { self.writer.startSessionAtSourceTime(pts) };
        }

        let adaptor = self.adaptor.lock().unwrap();
        // `readyForMoreMediaData` false ise kodlayıcı geride kalmış demektir. Beklemek
        // yakalama kuyruğunu tıkar ve GECİKME BİRİKİR; kareyi düşürmek doğru davranış.
        if !adaptor.assetWriterInput().isReadyForMoreMediaData() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }

        // Havuzdan bir tampon al ve kareyi ORAYA kopyala — kaynağı tutmuyoruz.
        let Some(pool) = (unsafe { adaptor.pixelBufferPool() }) else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        let mut owned: *mut std::ffi::c_void = std::ptr::null_mut();
        let rc = unsafe {
            CVPixelBufferPoolCreatePixelBuffer(
                std::ptr::null(),
                Retained::as_ptr(&pool) as *mut std::ffi::c_void,
                &mut owned,
            )
        };
        if rc != 0 || owned.is_null() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let copied = unsafe { copy_pixel_buffer(ptr, owned) };
        if !copied {
            unsafe { CFRelease(owned) };
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }

        let owned_ref: &CVPixelBuffer = unsafe { &*owned.cast::<CVPixelBuffer>() };
        let appended = unsafe { adaptor.appendPixelBuffer_withPresentationTime(owned_ref, pts) };
        unsafe { CFRelease(owned) };
        let _ = pixels;

        if appended {
            self.video_frames.fetch_add(1, Ordering::Relaxed);
        } else {
            // İlk başarısızlık sessiz kalmasın: yazıcı hata durumuna düştüyse
            // bundan SONRAKİ her ekleme de başarısız olur ve kayıt boş çıkar.
            if self.dropped.fetch_add(1, Ordering::Relaxed) == 0 {
                let err = unsafe { self.writer.error() };
                let reason = err
                    .as_ref()
                    .and_then(|e| e.localizedFailureReason())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                log::warn!(
                    "ilk kare eklenemedi — durum {:?}, sebep: {reason}",
                    unsafe { self.writer.status() }
                );
            }
        }
    }

    /// Bir ses örneği ekler. Oturum başlamadıysa sessizce atılır.
    ///
    /// # Safety
    /// `ptr` geçerli bir `CMSampleBufferRef` olmalı.
    pub unsafe fn append_audio(&self, ptr: *mut std::ffi::c_void) {
        if !self.session_started.load(Ordering::Acquire) {
            return; // ilk görüntü karesi henüz gelmedi
        }
        let Some(audio) = &self.audio else { return };
        let Some(sample) = (unsafe { Self::as_sample(ptr) }) else { return };
        let input = audio.lock().unwrap();
        if !input.isReadyForMoreMediaData() {
            self.audio_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if unsafe { input.appendSampleBuffer(sample) } {
            self.audio_samples.fetch_add(1, Ordering::Relaxed);
        } else {
            // İlk ses hatası sessiz kalmasın: biçim uyuşmazlığı tüm sesi düşürür.
            if self.audio_dropped.fetch_add(1, Ordering::Relaxed) == 0 {
                let err = unsafe { self.writer.error() };
                let reason = err
                    .as_ref()
                    .and_then(|e| e.localizedFailureReason())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                log::warn!("ilk ses örneği eklenemedi — sebep: {reason}");
            }
        }
    }

    /// Girdileri kapatır ve dosyayı sonlandırır. Tamamlanana kadar BLOKLAR.
    pub fn finish(&self, timeout: std::time::Duration) -> Result<(), String> {
        unsafe {
            if !self.session_started.load(Ordering::Acquire) {
                // Hiç kare gelmedi — oturum açılmadı, sonlandıracak bir şey yok.
                self.writer.cancelWriting();
                return Err("hiç kare yakalanamadı".into());
            }

            self.video.lock().unwrap().markAsFinished();
            if let Some(a) = &self.audio {
                a.lock().unwrap().markAsFinished();
            }

            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let block = block2::RcBlock::new(move || {
                let _ = tx.send(());
            });
            self.writer.finishWritingWithCompletionHandler(&block);

            // Zaman aşımı: sonlandırma takılırsa çağıran sonsuza dek beklemesin.
            let waited = rx.recv_timeout(timeout);

            let frames = self.video_frames.load(Ordering::Relaxed);
            let dropped = self.dropped.load(Ordering::Relaxed);
            let a_ok = self.audio_samples.load(Ordering::Relaxed);
            let a_drop = self.audio_dropped.load(Ordering::Relaxed);
            if dropped > 0 || a_drop > 0 {
                log::warn!(
                    "{frames} kare yazıldı ({dropped} düşürüldü), {a_ok} ses örneği ({a_drop} düşürüldü)"
                );
            } else {
                log::info!("{frames} kare yazıldı, {a_ok} ses örneği");
            }

            if waited.is_err() {
                return Err("sonlandırma zaman aşımına uğradı".into());
            }
            if self.writer.status() == AVAssetWriterStatus::Failed {
                return Err(format!("yazma başarısız: {:?}", self.writer.error()));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kalite_kademesi_bit_hizina_donusuyor() {
        // Electron'daki değerlerin aynısı olmalı — kaydın "eskisi gibi" görünmesi
        // buna bağlı.
        assert_eq!(quality_bitrate("ultra"), 50_000_000);
        assert_eq!(quality_bitrate("high"), 25_000_000);
        assert_eq!(quality_bitrate("medium"), 10_000_000);
        assert_eq!(quality_bitrate("low"), 5_000_000);
        // Bilinmeyen değer high'a düşer — kullanıcının kaydını bozmaktansa büyük
        // dosya üretmek yeğdir (quality_scale ile aynı politika).
        assert_eq!(quality_bitrate("bilinmeyen"), 25_000_000);
    }

    #[test]
    fn tavan_electron_hedefinin_altinda_kalmiyor() {
        // Ölçülen SCRecordingOutput tavanı ~10 Mbps'ti. Her kademe en az onun kadar
        // olmalı, yoksa "düzeltme" bazı kademelerde gerileme olurdu.
        for q in ["ultra", "high", "medium"] {
            assert!(
                quality_bitrate(q) >= 10_000_000,
                "{q} ölçülen tavanın altında"
            );
        }
    }
}
