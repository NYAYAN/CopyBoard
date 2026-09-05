//! Mikrofon + sistem sesini TEK ize karıştırır.
//!
//! ## Neden gerekli
//!
//! İlk çözüm iki kaynağı iki ayrı ses izine yazıyordu. Dosya bozulmuyordu ama
//! taşınabilir değildi: QuickTime iki izi birlikte çalıyor, VLC gibi oynatıcılar
//! varsayılan olarak yalnız ilkini çalıyor. Yani kaydı paylaşan kullanıcı karşı
//! tarafta mikrofonunu duyuramıyordu.
//!
//! ## Ölçülen biçimler
//!
//! Karıştırma kodunu yazmadan önce iki kaynağın gerçek biçimi ölçüldü — tahmin
//! etmek yanlış kod demekti:
//!
//! | Kaynak | Tampon | Kanal | Kare | Biçim |
//! |---|---|---|---|---|
//! | Sistem | 2 düzlem | 1'er | 960 | float32, DÜZLEMLİ stereo |
//! | Mikrofon | 1 tampon | 1 | 512 | float32, MONO |
//!
//! İkisi de 48 kHz, yani yeniden örnekleme YOK. Ama üç fark var ve üçü de ele
//! alınmalı: mikrofon mono (stereo'ya açılmalı), tampon boyları farklı (960'a karşı
//! 512, bir FIFO gerekiyor) ve tamponlar farklı thread'lerden geliyor.
//!
//! ## Yaklaşım: sistem tamponu TAŞIYICI
//!
//! Yeni bir `CMSampleBuffer` üretmek CoreMedia'da blok tamponu + biçim tanımı +
//! zamanlama kurmayı gerektiriyor. Bunun yerine sistem sesi tamponunun İÇİNE
//! karıştırılıyor: mikrofon örnekleri FIFO'da bekliyor, sistem tamponu geldiğinde
//! üzerine ekleniyor ve o tampon yazıcıya gidiyor. Böylece tek iz çıkıyor ve
//! CoreMedia tarafında tek satır bile yazmıyoruz.
//!
//! Sistem sesi kapalıysa taşıyıcı yok — mikrofon doğrudan yazılıyor, karıştırma
//! devre dışı.

use std::collections::VecDeque;
use std::sync::Mutex;

/// FIFO tavanı: 48 kHz'de ~0,5 saniye. Mikrofon sistem sesinden hızlı akarsa
/// (ya da sistem tamponu bir süre gelmezse) bellek büyümesin; taşan en ESKİ
/// örnekler atılıyor, çünkü geciken ses zaten kullanılamaz.
const MAX_FIFO: usize = 24_000;

#[derive(Default)]
pub struct Mixer {
    /// Bekleyen mikrofon örnekleri (mono, float32).
    mic: Mutex<VecDeque<f32>>,
    /// Kaç mikrofon örneği tavana takılıp atıldı? Tanı için.
    overflow: std::sync::atomic::AtomicU64,
}

impl Mixer {
    /// Mikrofon örneklerini kuyruğa alır.
    pub fn push_mic(&self, samples: &[f32]) {
        let mut q = self.mic.lock().unwrap();
        q.extend(samples);
        if q.len() > MAX_FIFO {
            let drop_n = q.len() - MAX_FIFO;
            q.drain(..drop_n);
            self.overflow
                .fetch_add(drop_n as u64, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Bir sistem sesi düzlemine bekleyen mikrofon örneklerini ekler.
    ///
    /// `advance` yalnız SON düzlem için `true` olmalı: aynı mikrofon örnekleri her
    /// iki stereo düzlemine de eklenmeli (mono → stereo), ama kuyruktan bir kez
    /// düşülmeli.
    pub fn mix_into(&self, plane: &mut [f32], advance: bool) {
        let mut q = self.mic.lock().unwrap();
        let n = plane.len().min(q.len());
        for (i, dst) in plane.iter_mut().take(n).enumerate() {
            // Toplama sonrası kırpma: iki kaynak da tam ses seviyesindeyse toplam
            // ±1'i aşar ve kırpılmazsa dijital bozulma (çıtırtı) duyulur.
            *dst = (*dst + q[i]).clamp(-1.0, 1.0);
        }
        if advance {
            q.drain(..n);
        }
    }

    /// Kuyrukta bekleyen örnek sayısı.
    pub fn pending(&self) -> usize {
        self.mic.lock().unwrap().len()
    }

    pub fn overflowed(&self) -> u64 {
        self.overflow.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Bayt dilimini `f32` dilimi olarak okur.
///
/// ScreenCaptureKit ses verisini 4 baytlık hizalı float32 olarak veriyor; yine de
/// hizalama kontrol ediliyor, çünkü hizasız okuma tanımsız davranış.
pub fn as_f32(bytes: &[u8]) -> &[f32] {
    if bytes.len() < 4 || (bytes.as_ptr() as usize) % std::mem::align_of::<f32>() != 0 {
        return &[];
    }
    unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<f32>(), bytes.len() / 4) }
}

/// Değiştirilebilir hâli — sistem tamponuna karıştırmak için.
///
/// # Safety
/// Çağıran, dilimin canlı bir ses tamponuna ait olduğunu ve başka kimsenin aynı anda
/// yazmadığını garanti etmeli.
pub unsafe fn as_f32_mut(bytes: &mut [u8]) -> &mut [f32] {
    if bytes.len() < 4 || (bytes.as_ptr() as usize) % std::mem::align_of::<f32>() != 0 {
        return &mut [];
    }
    unsafe { std::slice::from_raw_parts_mut(bytes.as_mut_ptr().cast::<f32>(), bytes.len() / 4) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_mikrofon_iki_duzleme_de_ekleniyor() {
        let m = Mixer::default();
        m.push_mic(&[0.5, 0.5, 0.5, 0.5]);

        // Sol düzlem: eklenir ama kuyruk DÜŞMEZ.
        let mut sol = [0.1f32; 4];
        m.mix_into(&mut sol, false);
        assert_eq!(m.pending(), 4, "ilk düzlem kuyruğu tüketmemeli");

        // Sağ düzlem: aynı örnekler eklenir ve kuyruk düşer.
        let mut sag = [0.1f32; 4];
        m.mix_into(&mut sag, true);
        assert_eq!(m.pending(), 0);

        assert_eq!(sol, sag, "mono kaynak iki kanalda da AYNI olmalı");
        for v in sol {
            assert!((v - 0.6).abs() < 1e-6, "0.1 + 0.5 = 0.6 bekleniyordu, {v} geldi");
        }
    }

    #[test]
    fn toplam_kirpiliyor() {
        // İki kaynak da tam seviyedeyse toplam ±1'i aşar; kırpılmazsa çıtırtı olur.
        let m = Mixer::default();
        m.push_mic(&[0.8, -0.8]);
        let mut plane = [0.7f32, -0.7];
        m.mix_into(&mut plane, true);
        assert_eq!(plane, [1.0, -1.0]);
    }

    #[test]
    fn mikrofon_azsa_kalan_kisim_dokunulmadan_kaliyor() {
        // Mikrofon tamponu 512 kare, sistem tamponu 960 — eksik kısım sistem sesiyle
        // devam etmeli, sıfırlanmamalı.
        let m = Mixer::default();
        m.push_mic(&[1.0, 1.0]);
        let mut plane = [0.25f32; 5];
        m.mix_into(&mut plane, true);
        assert_eq!(plane[0], 1.0);
        assert_eq!(plane[1], 1.0);
        assert_eq!(&plane[2..], &[0.25, 0.25, 0.25], "karışmayan kısım bozulmamalı");
        assert_eq!(m.pending(), 0);
    }

    #[test]
    fn fifo_tavani_en_eskiyi_atiyor() {
        let m = Mixer::default();
        m.push_mic(&vec![0.1; MAX_FIFO + 1000]);
        assert_eq!(m.pending(), MAX_FIFO, "tavan aşılmamalı");
        assert_eq!(m.overflowed(), 1000);
    }

    #[test]
    fn hizasiz_veya_kisa_dilim_bos_donuyor() {
        assert!(as_f32(&[1, 2, 3]).is_empty(), "4 bayttan kısa");
        let buf = [0u8; 16];
        assert_eq!(as_f32(&buf).len(), 4);
    }
}
