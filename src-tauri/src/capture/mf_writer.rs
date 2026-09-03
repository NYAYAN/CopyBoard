//! MP4 yazıcı — Media Foundation Sink Writer (Windows).
//!
//! Video (BGRA kareler → H.264) ve isteğe bağlı ses (16-bit PCM → AAC) tek bir MP4
//! kapsayıcısına yazılıyor. Kodlama ve mux Media Foundation'ın kendi kodlayıcı
//! MFT'leriyle yapılıyor; ek bağımlılık yok.
//!
//! ## Neden `windows-capture`'ın kodlayıcısı değil
//!
//! O kodlayıcı ses akışını `AudioEncodingProperties::CreateAac` ile, yani ZATEN
//! KODLANMIŞ AAC bekleyerek tanımlıyor; `send_audio_buffer`'a ham PCM verilemiyor.
//! WASAPI'den gelen ise ham PCM. Sink Writer her ikisini de alıp kendi kodluyor.
//!
//! ## Zaman damgaları
//!
//! 100 ns birim, kayıt başlangıcına göreli. Video kareleri WGC'nin QPC tabanlı
//! `SystemRelativeTime`'ından, ses paketleri WASAPI'nin QPC konumundan geliyor —
//! ikisi aynı saat, o yüzden birbirine kayma yok (bkz. `wasapi.rs`).
//!
//! ## Thread'ler
//!
//! Kareler WGC thread'inden, ses karıştırıcı thread'inden geliyor. `IMFSinkWriter`
//! çağrıları bir `Mutex` ardında sıralanıyor (yazıcı eşzamanlı `WriteSample`
//! desteklemiyor). `Finalize` ilk `WriteSample`den önce gelirse (hiç kare yoksa) MF
//! hata verir; `finish` bunu "boş kayıt" olarak raporluyor.

#![cfg(target_os = "windows")]

use windows::core::{Interface, HSTRING};
use windows::Win32::Media::MediaFoundation::*;

/// `MF_VERSION` — `(MF_SDK_VERSION << 16) | MF_API_VERSION`.
const MF_VERSION_VALUE: u32 = (MF_SDK_VERSION << 16) | MF_API_VERSION;

/// 100 ns biriminde bir saniye.
pub const HNS_PER_SEC: i64 = 10_000_000;

pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u32,
}

pub struct MfWriter {
    writer: IMFSinkWriter,
    video_stream: u32,
    audio_stream: Option<u32>,
    width: u32,
    height: u32,
    video_written: u64,
    audio_written: u64,
    finished: bool,
}

// SAFETY: IMFSinkWriter free-threaded bir COM nesnesi; çağrılar dışarıda bir Mutex ile
// sıralanıyor (bkz. recorder_win.rs). Yazıcı yalnız bu sarmalayıcı üzerinden kullanılıyor.
unsafe impl Send for MfWriter {}

fn pack_u64(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

impl MfWriter {
    /// Yazıcıyı kurar. `width/height` ÇİFT olmalı (H.264). `audio` verilirse AAC akışı da açılır.
    pub fn new(
        path: &std::path::Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        audio: Option<AudioFormat>,
    ) -> Result<Self, String> {
        // SAFETY: Media Foundation çağrıları belgelenen sırayla yapılıyor; her COM
        // nesnesi `windows` crate'inin akıllı işaretçisiyle yönetiliyor.
        unsafe {
            MFStartup(MF_VERSION_VALUE, MFSTARTUP_FULL).map_err(|e| format!("MFStartup: {e}"))?;

            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 2).map_err(|e| format!("MFCreateAttributes: {e}"))?;
            let attrs = attrs.ok_or("MFCreateAttributes boş döndü")?;
            // ⚠ Throttling AÇIK kalıyor — ölçüldü (B12): `MF_SINK_WRITER_DISABLE_THROTTLING=1`
            // ile yazıcı `WriteSample`ı hiç bloklamıyor ve akışları eşlemek için kareleri
            // sınırsız biriktiriyor: 30 sn'lik ultra kayıtta çalışma kümesi 2,3 GB'a çıktı
            // (her kare ~3,7 MB, hepsi bellekte). Throttling ile `WriteSample` kodlayıcı
            // yetişemezse bloklar; bu WGC thread'ini duraklatır ve yalnız kare düşürür.
            attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1).map_err(|e| e.to_string())?;

            let url = HSTRING::from(path.as_os_str());
            let writer = MFCreateSinkWriterFromURL(&url, None, Some(&attrs))
                .map_err(|e| format!("MFCreateSinkWriterFromURL: {e}"))?;

            // ── Video çıkışı: H.264 ─────────────────────────────────────────────
            let vout = MFCreateMediaType().map_err(|e| e.to_string())?;
            vout.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            vout.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(|e| e.to_string())?;
            vout.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).map_err(|e| e.to_string())?;
            vout.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
            vout.SetUINT64(&MF_MT_FRAME_SIZE, pack_u64(width, height)).map_err(|e| e.to_string())?;
            vout.SetUINT64(&MF_MT_FRAME_RATE, pack_u64(fps, 1)).map_err(|e| e.to_string())?;
            vout.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u64(1, 1)).map_err(|e| e.to_string())?;
            let video_stream = writer.AddStream(&vout).map_err(|e| format!("AddStream(video): {e}"))?;

            // ── Video girişi: RGB32 (BGRA). Pozitif `MF_MT_DEFAULT_STRIDE` ile kodlayıcı
            //    satırları ÜSTTEN ALTA okuyor (cv2 ile ölçüldü, bkz. recorder_win.rs);
            //    WGC kareleri de üstten alta, o yüzden çevirme yok. ──────────────────
            let vin = MFCreateMediaType().map_err(|e| e.to_string())?;
            vin.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            vin.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(|e| e.to_string())?;
            vin.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
            vin.SetUINT64(&MF_MT_FRAME_SIZE, pack_u64(width, height)).map_err(|e| e.to_string())?;
            vin.SetUINT64(&MF_MT_FRAME_RATE, pack_u64(fps, 1)).map_err(|e| e.to_string())?;
            vin.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u64(1, 1)).map_err(|e| e.to_string())?;
            vin.SetUINT32(&MF_MT_DEFAULT_STRIDE, width * 4).map_err(|e| e.to_string())?;
            vin.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1).map_err(|e| e.to_string())?;
            writer
                .SetInputMediaType(video_stream, &vin, None)
                .map_err(|e| format!("SetInputMediaType(video): {e}"))?;

            // ── Ses: AAC çıkış, 16-bit PCM giriş ─────────────────────────────────
            let audio_stream = match audio {
                None => None,
                Some(a) => {
                    let aout = MFCreateMediaType().map_err(|e| e.to_string())?;
                    aout.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
                    aout.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(|e| e.to_string())?;
                    aout.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|e| e.to_string())?;
                    aout.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, a.sample_rate).map_err(|e| e.to_string())?;
                    aout.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, a.channels).map_err(|e| e.to_string())?;
                    // AAC kodlayıcının kabul ettiği bayt/sn değerleri: 12000, 16000, 20000, 24000.
                    aout.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000).map_err(|e| e.to_string())?;
                    let stream = writer.AddStream(&aout).map_err(|e| format!("AddStream(audio): {e}"))?;

                    let ain = MFCreateMediaType().map_err(|e| e.to_string())?;
                    ain.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
                    ain.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(|e| e.to_string())?;
                    ain.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|e| e.to_string())?;
                    ain.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, a.sample_rate).map_err(|e| e.to_string())?;
                    ain.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, a.channels).map_err(|e| e.to_string())?;
                    let block_align = a.channels * 2;
                    ain.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block_align).map_err(|e| e.to_string())?;
                    ain.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, a.sample_rate * block_align).map_err(|e| e.to_string())?;
                    ain.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1).map_err(|e| e.to_string())?;
                    writer
                        .SetInputMediaType(stream, &ain, None)
                        .map_err(|e| format!("SetInputMediaType(audio): {e}"))?;
                    Some(stream)
                }
            };

            writer.BeginWriting().map_err(|e| format!("BeginWriting: {e}"))?;

            Ok(Self { writer, video_stream, audio_stream, width, height, video_written: 0, audio_written: 0, finished: false })
        }
    }

    pub fn has_audio(&self) -> bool {
        self.audio_stream.is_some()
    }

    pub fn video_frames(&self) -> u64 {
        self.video_written
    }

    pub fn audio_samples(&self) -> u64 {
        self.audio_written
    }

    fn write(&self, stream: u32, bytes: &[u8], ts: i64, dur: i64) -> Result<(), String> {
        // SAFETY: tampon MF tarafından ayrılıyor, kilitli süre boyunca kopyalanıyor,
        // uzunluğu açıkça set ediliyor; örnek yalnız bu tamponu taşıyor.
        unsafe {
            let buf = MFCreateMemoryBuffer(bytes.len() as u32).map_err(|e| format!("MFCreateMemoryBuffer: {e}"))?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            buf.Lock(&mut ptr, None, None).map_err(|e| format!("Lock: {e}"))?;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            buf.Unlock().map_err(|e| format!("Unlock: {e}"))?;
            buf.SetCurrentLength(bytes.len() as u32).map_err(|e| e.to_string())?;

            let sample = MFCreateSample().map_err(|e| format!("MFCreateSample: {e}"))?;
            sample.AddBuffer(&buf).map_err(|e| e.to_string())?;
            sample.SetSampleTime(ts).map_err(|e| e.to_string())?;
            sample.SetSampleDuration(dur).map_err(|e| e.to_string())?;
            self.writer.WriteSample(stream, &sample).map_err(|e| format!("WriteSample: {e}"))
        }
    }

    /// BGRA kare (`width*height*4` bayt, satırlar alttan üste). `ts`/`dur` 100 ns.
    pub fn write_video(&mut self, bgra: &[u8], ts: i64, dur: i64) -> Result<(), String> {
        let need = (self.width * self.height * 4) as usize;
        if bgra.len() < need {
            return Err(format!("kare kısa: {} < {need}", bgra.len()));
        }
        self.write(self.video_stream, &bgra[..need], ts, dur)?;
        self.video_written += 1;
        Ok(())
    }

    /// 16-bit PCM, `channels` kanal interleaved. `ts`/`dur` 100 ns.
    pub fn write_audio(&mut self, pcm: &[u8], ts: i64, dur: i64) -> Result<(), String> {
        let Some(stream) = self.audio_stream else { return Ok(()) };
        if pcm.is_empty() {
            return Ok(());
        }
        self.write(stream, pcm, ts, dur)?;
        self.audio_written += pcm.len() as u64 / 2;
        Ok(())
    }

    /// Mux'u tamamlar. Hiç kare yazılmadıysa `Finalize` MF'de hata verir; bu durum
    /// "kayıt boş" olarak döndürülüyor.
    pub fn finish(mut self) -> Result<u64, String> {
        self.finished = true;
        if self.video_written == 0 {
            // SAFETY: yazıcı düşürülürken MF kapatılıyor.
            unsafe { let _ = MFShutdown(); }
            return Err("kayıt dosyası boş (hiç kare gelmedi)".into());
        }
        // SAFETY: bkz. üst.
        let r = unsafe { self.writer.Finalize() }.map_err(|e| format!("Finalize: {e}"));
        unsafe { let _ = MFShutdown(); }
        r.map(|_| self.video_written)
    }
}

impl Drop for MfWriter {
    fn drop(&mut self) {
        if !self.finished {
            // Yarıda kalan kayıt: dosyayı elden geldiğince kapat.
            // SAFETY: bkz. `finish`.
            unsafe {
                let _ = self.writer.Finalize();
                let _ = MFShutdown();
            }
        }
    }
}

// `Interface` içe aktarımı: `windows` crate'i bazı sürümlerde GUID sabitlerini bu trait
// üzerinden çözüyor; kullanılmasa bile derleyici uyarısı olmasın diye tutuluyor.
#[allow(dead_code)]
fn _interface_marker<T: Interface>(_: &T) {}
