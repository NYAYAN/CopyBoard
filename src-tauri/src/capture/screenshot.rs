//! Ekran yakalama — `desktopCapturer.getSources()`'un karşılığı, `xcap` üzerinden.
//!
//! ## Electron'a göre iki kazanç (Spike-3'te ölçüldü)
//!
//! 1. **Her monitör kendi yerel çözünürlüğünde.** `desktopCapturer` tek bir
//!    `thumbnailSize`'ı çağrının TAMAMINA uyguluyordu, bu yüzden 4K bir monitörün
//!    yanındaki 1080p ekran önce büyütülüp sonra küçültülüyor ve bulanıklaşıyordu.
//!    `capture-service.js` bunu monitör başına ayrı `getSources()` çağırarak çözüyordu.
//!    `xcap`'ta bu sorun yok.
//!
//! 2. **Hız.** Ölçüldü: yakalama 26-36 ms, PNG encode 34 ms (3600×2338 için, release).
//!
//! ## Boş kare yeniden denemesi
//!
//! macOS'ta ScreenCaptureKit ısınırken ilk yakalama boş dönebiliyor. Spike-3'te üç turun
//! hiçbirinde olmadı, ama tek bir makinedeki tek bir ölçüm GPU/sürücü çeşitliliğini
//! kapatmaz — Electron sürümünün 5 denemeli döngüsü hafifletilmiş hâliyle korunuyor.
//! Boş bir kare sessizce felakettir: overlay şeffaf olduğu için canlı masaüstü içinden
//! görünür, kullanıcı normalmiş gibi seçip çizer, ve hata ancak yapıştırdığında
//! SİYAH BİR DİKDÖRTGEN olarak ortaya çıkar.

use std::time::Duration;

use crate::geom::MonitorInfo;

const ATTEMPTS: usize = 3;
const RETRY_DELAY: Duration = Duration::from_millis(120);

pub struct Frame {
    /// PNG baytları. Renderer bunu `createImageBitmap(new Blob([...], 'image/png'))`
    /// ile çözüyor — ham RGBA'ya geçmek `snipper.js`'i değiştirmeyi gerektirirdi ve
    /// tek karede PNG hem daha az IPC hem yeterince hızlı (bkz. KARAR S3-b).
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Bir monitörü FİZİKSEL piksel çözünürlüğünde yakalar.
pub fn capture_monitor(target: &MonitorInfo, index: usize) -> Option<Frame> {
    let (want_w, want_h) = target.physical_size();

    for attempt in 1..=ATTEMPTS {
        match try_capture(target, index) {
            Some(frame) => return Some(frame),
            None if attempt < ATTEMPTS => {
                log::warn!(
                    "boş ekran görüntüsü ({want_w}x{want_h}, deneme {attempt}/{ATTEMPTS}) — yeniden deneniyor"
                );
                std::thread::sleep(RETRY_DELAY);
            }
            None => {}
        }
    }
    log::error!("ekran görüntüsü alınamadı ({want_w}x{want_h}): {ATTEMPTS} denemenin hepsi boş döndü");
    None
}

fn try_capture(target: &MonitorInfo, index: usize) -> Option<Frame> {
    let monitors = xcap::Monitor::all().ok()?;

    // ── ⚠ Koordinat uzayı ────────────────────────────────────────────────────
    // İlk hâli `target.x * target.scale`i xcap'in `m.x()`iyle karşılaştırıyordu.
    // Bu YANLIŞ: xcap macOS'ta `x()/y()`yi doğrudan `CGDisplayBounds.origin` olarak,
    // yani NOKTA cinsinden veriyor (ölçeksiz). Sol taraf fiziksel, sağ taraf noktaydı.
    // Sonuç: orijinde olmayan ve ölçeği 1'den farklı monitörlerde eşleşme başarısız
    // oluyor, fallback birincil ekrana düşüyor ve ÇOK MONİTÖRLÜ bir kurulumda TÜM
    // overlay'ler aynı (yanlış) görüntüyü alıyordu — hiçbir hata vermeden.
    //
    // İki taraf da NOKTA: `MonitorInfo.x/y` zaten mantıksal.
    let (tx, ty) = (target.x.round() as i32, target.y.round() as i32);

    let monitor = monitors
        .iter()
        .find(|m| m.x().unwrap_or(i32::MIN) == tx && m.y().unwrap_or(i32::MIN) == ty)
        // Eşleşme yoksa İNDEKS sırasına düş — Electron'un fallback'i de buydu
        // (`sources[index] || sources[0]`), ve önemli farkı şu: her monitör yine
        // FARKLI bir kaynak alıyor, hepsi birden birincil ekrana çökmüyor.
        .or_else(|| monitors.get(index))
        .or_else(|| monitors.first())?;

    let image = monitor.capture_image().ok()?;
    let (w, h) = (image.width(), image.height());
    if w == 0 || h == 0 {
        return None;
    }

    // Boş/tek renk mi? Seyrek örnekleme — tam tarama 32 MB'lık bir kare için israf.
    let raw = image.as_raw();
    let sample_step = 97;
    let sampled = raw.len() / sample_step;
    let non_zero = raw.iter().step_by(sample_step).filter(|b| **b != 0).count();
    if sampled > 0 && non_zero * 100 / sampled < 2 {
        return None; // neredeyse tamamen siyah — ısınmamış kare
    }

    let mut png = Vec::with_capacity((w * h / 8) as usize);
    {
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(raw, w, h, image::ExtendedColorType::Rgba8)
            .ok()?;
    }

    Some(Frame { png, width: w, height: h })
}
