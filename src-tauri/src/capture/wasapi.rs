//! Ses yakalama — WASAPI (Windows).
//!
//! İki kaynak, aynı boru hattı:
//!
//! * **Mikrofon**: varsayılan yakalama uç noktası (`eCapture`).
//! * **Sistem sesi**: varsayılan çalma uç noktasının **loopback**'i
//!   (`AUDCLNT_STREAMFLAGS_LOOPBACK`). Electron sürümü Windows'ta bunu
//!   `getUserMedia` loopback'iyle yapıyordu; sanal aygıt gerekmiyor.
//!
//! Her kaynak kendi thread'inde paylaşımlı modda, aygıtın karışım biçimiyle açılıyor
//! (çoğunlukla 32-bit float, 48 kHz, 2 kanal; 44.1 kHz da olabiliyor). Paketler
//! **48 kHz / stereo / 16-bit**e çevriliyor (kanal indirgeme, float→i16, gerekirse
//! doğrusal yeniden örnekleme) ve bir karıştırıcıya bırakılıyor. Karıştırıcı 20 ms'lik
//! parçalar hâlinde toplayıp `MfWriter`'a yazıyor.
//!
//! ## Zaman damgaları
//!
//! Karıştırıcı çıkışı ÖRNEK SAYACINA dayanıyor: `ts = ilk_paket_qpc - t0 + yazılan/48000`.
//! İlk paketin QPC konumu WASAPI'den geliyor (`GetBuffer`'ın `pu64QPCPosition`'ı),
//! video kareleri de WGC'nin QPC tabanlı damgasını kullanıyor — tek saat, sürüklenme yok.
//!
//! ## Loopback sessizken
//!
//! Hiçbir şey çalmıyorsa loopback paket vermez. Karıştırıcı duvar saatine göre ilerliyor:
//! bir kaynak geride kalmışsa o parça için SESSİZLİK yazılıyor, ses zaman çizgisi
//! kopmuyor. Fazla birikme 300 ms'de kırpılıyor (gecikme büyümesin).

#![cfg(target_os = "windows")]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::core::{Interface, GUID};
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

use super::mf_writer::{MfWriter, HNS_PER_SEC};

pub const OUT_RATE: u32 = 48_000;
pub const OUT_CHANNELS: u32 = 2;
/// Karıştırıcı parça boyu: 20 ms = 960 kare.
const CHUNK_FRAMES: usize = (OUT_RATE as usize) / 50;
/// Bir kaynağın biriktirebileceği azami ses (gecikme tavanı).
const MAX_BACKLOG_FRAMES: usize = (OUT_RATE as usize) * 3 / 10;

const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
const WAVE_FORMAT_PCM_TAG: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;

/// Bir kaynaktan karıştırıcıya akan ses: 48 kHz stereo i16, interleaved.
struct SourceQueue {
    frames: VecDeque<[i16; 2]>,
}

/// Şu anki QPC zamanı, 100 ns biriminde. WGC kare damgaları ve WASAPI paket konumları
/// aynı saati kullanıyor; kaydedici `t0`'ı da bununla alıyor.
pub fn qpc_now_hns() -> i64 {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let (mut counter, mut freq) = (0i64, 0i64);
    // SAFETY: saf sorgular.
    unsafe {
        let _ = QueryPerformanceFrequency(&mut freq);
        let _ = QueryPerformanceCounter(&mut counter);
    }
    if freq <= 0 {
        return 0;
    }
    // Taşmasın: saniye ve kalan ayrı ölçekleniyor.
    let secs = counter / freq;
    let rem = counter % freq;
    secs * HNS_PER_SEC + rem * HNS_PER_SEC / freq
}

struct Shared {
    queues: Vec<Mutex<SourceQueue>>,
}

/// Çalışan yakalama: `stop()` thread'leri bitirip son parçayı yazar.
pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl AudioCapture {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

/// Ses yakalamayı başlatır. `t0` kaydın QPC başlangıcı (100 ns), video ile ortak.
/// `writer` karıştırıcının yazacağı yer; kayıt bitince `None` yapılır.
pub fn start(
    mic: bool,
    system: bool,
    t0: i64,
    writer: Arc<Mutex<Option<MfWriter>>>,
) -> Result<AudioCapture, String> {
    let mut kinds = Vec::new();
    if system { kinds.push(true); }   // loopback
    if mic { kinds.push(false); }
    if kinds.is_empty() {
        return Err("ses kaynağı seçilmedi".into());
    }
    let shared = Arc::new(Shared {
        queues: kinds.iter().map(|_| Mutex::new(SourceQueue { frames: VecDeque::new() })).collect(),
    });
    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = Vec::new();

    // İlk paket başarısızlığını başlatana bildirmek için.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    for (idx, &loopback) in kinds.iter().enumerate() {
        let shared = shared.clone();
        let stop = stop.clone();
        let tx = ready_tx.clone();
        threads.push(
            std::thread::Builder::new()
                .name(if loopback { "copyboard-audio-loopback".into() } else { "copyboard-audio-mic".into() })
                .spawn(move || capture_thread(loopback, idx, shared, stop, tx))
                .map_err(|e| e.to_string())?,
        );
    }
    drop(ready_tx);
    // Her kaynak açılışını raporlasın; biri açılamazsa kayıt sessiz devam etmesin, hata dönsün.
    for _ in 0..kinds.len() {
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                stop.store(true, Ordering::Release);
                return Err(e);
            }
            Err(_) => {
                stop.store(true, Ordering::Release);
                return Err("ses aygıtı zaman aşımına uğradı".into());
            }
        }
    }

    // Karıştırıcı
    {
        let shared = shared.clone();
        let stop = stop.clone();
        threads.push(
            std::thread::Builder::new()
                .name("copyboard-audio-mixer".into())
                .spawn(move || mixer_thread(shared, stop, t0, writer))
                .map_err(|e| e.to_string())?,
        );
    }

    Ok(AudioCapture { stop, threads })
}

// ── Yakalama thread'i ────────────────────────────────────────────────────────

struct Format {
    rate: u32,
    channels: u16,
    float: bool,
    bits: u16,
    block_align: u16,
}

fn describe_format(wf: &WAVEFORMATEX) -> Result<Format, String> {
    let tag = wf.wFormatTag;
    let float = if tag == WAVE_FORMAT_IEEE_FLOAT_TAG {
        true
    } else if tag == WAVE_FORMAT_PCM_TAG {
        false
    } else if tag == WAVE_FORMAT_EXTENSIBLE as u16 {
        // SAFETY: tag EXTENSIBLE ise yapı WAVEFORMATEXTENSIBLE'dır (cbSize ≥ 22). Yapı
        // `packed`, o yüzden alan referansla değil `read_unaligned` ile okunuyor.
        let sub: GUID = unsafe {
            let ext = wf as *const WAVEFORMATEX as *const WAVEFORMATEXTENSIBLE;
            std::ptr::addr_of!((*ext).SubFormat).read_unaligned()
        };
        if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
            true
        } else if sub == KSDATAFORMAT_SUBTYPE_PCM {
            false
        } else {
            return Err(format!("desteklenmeyen ses alt biçimi {sub:?}"));
        }
    } else {
        return Err(format!("desteklenmeyen ses biçimi etiketi {tag}"));
    };
    Ok(Format {
        rate: wf.nSamplesPerSec,
        channels: wf.nChannels,
        float,
        bits: wf.wBitsPerSample,
        block_align: wf.nBlockAlign,
    })
}

/// Aygıt paketini 48 kHz stereo i16 karelere çevirir ve kuyruğa ekler.
struct Converter {
    fmt: Format,
    /// Yeniden örnekleme konumu (kaynak kare cinsinden kesirli).
    pos: f64,
    /// Son kaynak karesi (doğrusal enterpolasyon için).
    prev: [f32; 2],
    have_prev: bool,
}

impl Converter {
    fn new(fmt: Format) -> Self {
        Self { fmt, pos: 0.0, prev: [0.0; 2], have_prev: false }
    }

    fn sample(&self, data: &[u8], frame: usize, ch: usize) -> f32 {
        let ba = self.fmt.block_align as usize;
        let bps = (self.fmt.bits / 8) as usize;
        let off = frame * ba + ch * bps;
        if off + bps > data.len() {
            return 0.0;
        }
        let b = &data[off..off + bps];
        if self.fmt.float {
            f32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            match bps {
                2 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
                3 => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
                4 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
                _ => 0.0,
            }
        }
    }

    /// Kaynak karesini stereo float'a indirger.
    fn stereo(&self, data: &[u8], frame: usize) -> [f32; 2] {
        let ch = self.fmt.channels as usize;
        if ch == 1 {
            let m = self.sample(data, frame, 0);
            [m, m]
        } else {
            [self.sample(data, frame, 0), self.sample(data, frame, 1)]
        }
    }

    fn push(&mut self, data: &[u8], frames: usize, out: &mut VecDeque<[i16; 2]>) {
        let to_i16 = |v: f32| (v.clamp(-1.0, 1.0) * 32767.0) as i16;
        if self.fmt.rate == OUT_RATE {
            for f in 0..frames {
                let s = self.stereo(data, f);
                out.push_back([to_i16(s[0]), to_i16(s[1])]);
            }
            return;
        }
        // Doğrusal yeniden örnekleme: kaynak hızından 48 kHz'e.
        let step = self.fmt.rate as f64 / OUT_RATE as f64;
        let mut idx = self.pos;
        while (idx.floor() as usize) < frames {
            let i = idx.floor() as usize;
            let frac = (idx - i as f64) as f32;
            let a = if i == 0 && self.have_prev { self.prev } else { self.stereo(data, i.saturating_sub(if i == 0 { 0 } else { 1 })) };
            let b = self.stereo(data, i);
            let (a, b) = if i == 0 && !self.have_prev { (b, b) } else { (a, b) };
            out.push_back([
                to_i16(a[0] + (b[0] - a[0]) * frac),
                to_i16(a[1] + (b[1] - a[1]) * frac),
            ]);
            idx += step;
        }
        self.pos = idx - frames as f64;
        if frames > 0 {
            self.prev = self.stereo(data, frames - 1);
            self.have_prev = true;
        }
    }
}

fn capture_thread(
    loopback: bool,
    idx: usize,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    // SAFETY: WASAPI çağrıları belgelenen sırayla; her COM nesnesi akıllı işaretçide.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let result: Result<(IAudioClient, IAudioCaptureClient, Converter), String> = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("MMDeviceEnumerator: {e}"))?;
            let flow = if loopback { eRender } else { eCapture };
            let device = enumerator
                .GetDefaultAudioEndpoint(flow, eConsole)
                .map_err(|e| format!("varsayılan {} aygıtı yok: {e}", if loopback { "çalma" } else { "mikrofon" }))?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| format!("IAudioClient: {e}"))?;
            let wf_ptr = client.GetMixFormat().map_err(|e| format!("GetMixFormat: {e}"))?;
            let fmt = describe_format(&*wf_ptr);
            let flags = if loopback { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
            // 100 ms tampon; yoklama 10 ms.
            let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, HNS_PER_SEC / 10, 0, wf_ptr, None);
            CoTaskMemFree(Some(wf_ptr as *const _ as *const core::ffi::c_void));
            init.map_err(|e| format!("IAudioClient::Initialize: {e}"))?;
            let fmt = fmt?;
            let capture: IAudioCaptureClient = client.GetService().map_err(|e| format!("IAudioCaptureClient: {e}"))?;
            client.Start().map_err(|e| format!("IAudioClient::Start: {e}"))?;
            log::info!(
                "ses [{}]: {} Hz, {} kanal, {}{}",
                if loopback { "sistem" } else { "mikrofon" },
                fmt.rate, fmt.channels, fmt.bits, if fmt.float { "-bit float" } else { "-bit PCM" }
            );
            Ok((client, capture, Converter::new(fmt)))
        })();

        let (client, capture, mut conv) = match result {
            Ok(v) => { let _ = ready.send(Ok(())); v }
            Err(e) => { let _ = ready.send(Err(e)); CoUninitialize(); return; }
        };

        while !stop.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(10));
            loop {
                let packet = match capture.GetNextPacketSize() {
                    Ok(n) if n > 0 => n,
                    _ => break,
                };
                let _ = packet;
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                let mut qpc = 0u64;
                if capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc)).is_err() {
                    break;
                }
                let n = frames as usize;
                let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                let bytes = n * conv.fmt.block_align as usize;
                {
                    let mut q = shared.queues[idx].lock().unwrap_or_else(|p| p.into_inner());
                    let _ = qpc; // QPC konumu alınıyor ama zaman çizgisi duvar saatine göre (bkz. mixer_thread)
                    if silent || data.is_null() {
                        // Sessiz paket: aynı süre kadar sıfır.
                        let out_frames = (n as u64 * OUT_RATE as u64 / conv.fmt.rate as u64) as usize;
                        for _ in 0..out_frames { q.frames.push_back([0, 0]); }
                    } else {
                        let slice = std::slice::from_raw_parts(data, bytes);
                        conv.push(slice, n, &mut q.frames);
                    }
                    // Gecikme tavanı.
                    while q.frames.len() > MAX_BACKLOG_FRAMES { q.frames.pop_front(); }
                }
                let _ = capture.ReleaseBuffer(frames);
            }
        }
        let _ = client.Stop();
        CoUninitialize();
    }
}

// ── Karıştırıcı ──────────────────────────────────────────────────────────────

fn mixer_thread(shared: Arc<Shared>, stop: Arc<AtomicBool>, t0: i64, writer: Arc<Mutex<Option<MfWriter>>>) {
    let mut written: u64 = 0; // yazılan 48 kHz kare sayısı
    // ⚠ Zaman çizgisi ŞİMDİ başlıyor, ilk paketle değil — ölçüldü (B12).
    // İlk hâli ilk paketin QPC'sini bekliyordu. Sistemde ses çalmıyorsa loopback HİÇ
    // paket vermez; ses akışına tek örnek yazılmadan Sink Writer akışları eşleyebilmek
    // için video karelerini tutuyordu (sesli kayıtta ~3 MB/sn bellek büyümesi, throttling
    // kapalıyken 30 sn'de 2,3 GB). Şimdi çizgi kayıt başlangıcına göre kuruluyor ve
    // paket gelmeyen süre sessizlikle dolduruluyor; paketler gelince kuyruk boş olduğu
    // için gerçek zamanlarına ±20 ms içinde oturuyorlar.
    let base_ts = (qpc_now_hns() - t0).max(0);
    let started = Instant::now();
    let mut chunk = vec![0u8; CHUNK_FRAMES * 4];

    loop {
        let stopping = stop.load(Ordering::Acquire);
        // Duvar saati: karıştırıcı başından bu yana kaç kare üretilmiş olmalı?
        let due = (started.elapsed().as_secs_f64() * OUT_RATE as f64) as u64;
        // Yeterli birikim yoksa bekle — ama duvar saati ilerlemişse sessizlikle doldur.
        let mut have_all = true;
        for q in &shared.queues {
            if q.lock().unwrap_or_else(|p| p.into_inner()).frames.len() < CHUNK_FRAMES { have_all = false; }
        }
        let behind = written + CHUNK_FRAMES as u64 <= due;
        if !have_all && !behind && !stopping {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        if stopping {
            // Kalan ne varsa bir parça daha, sonra çık.
            let any = shared.queues.iter().any(|q| !q.lock().unwrap_or_else(|p| p.into_inner()).frames.is_empty());
            if !any { break; }
        }

        // Karıştır: kaynaklardan al, eksikleri sessizlikle tamamla, topla, kırp.
        let mut acc = vec![[0i32; 2]; CHUNK_FRAMES];
        for q in &shared.queues {
            let mut g = q.lock().unwrap_or_else(|p| p.into_inner());
            for slot in acc.iter_mut() {
                if let Some(f) = g.frames.pop_front() {
                    slot[0] += f[0] as i32;
                    slot[1] += f[1] as i32;
                }
            }
        }
        for (i, s) in acc.iter().enumerate() {
            let l = s[0].clamp(-32768, 32767) as i16;
            let r = s[1].clamp(-32768, 32767) as i16;
            chunk[i * 4..i * 4 + 2].copy_from_slice(&l.to_le_bytes());
            chunk[i * 4 + 2..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
        }
        let ts = base_ts + (written as i64) * HNS_PER_SEC / OUT_RATE as i64;
        let dur = (CHUNK_FRAMES as i64) * HNS_PER_SEC / OUT_RATE as i64;
        {
            let mut w = writer.lock().unwrap_or_else(|p| p.into_inner());
            match w.as_mut() {
                Some(w) => {
                    if let Err(e) = w.write_audio(&chunk, ts, dur) {
                        log::warn!("ses yazılamadı: {e}");
                    }
                }
                None => break, // yazıcı kapandı
            }
        }
        written += CHUNK_FRAMES as u64;
    }
    log::info!("ses karıştırıcı bitti: {:.1} sn", written as f64 / OUT_RATE as f64);
}

// GUID karşılaştırmaları için `Interface` bazı sürümlerde gerekli; kullanılmıyorsa uyarı olmasın.
#[allow(dead_code)]
fn _iface<T: Interface>(_: &T) {}
