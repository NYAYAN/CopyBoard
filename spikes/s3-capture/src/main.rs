// S3 spike — xcap ile çok monitörlü, farklı DPI'lı yakalama Electron'un
// desktopCapturer'ı kadar iyi mi?
//
// Ölçülen sorular:
//   1. Her monitör KENDİ yerel (fiziksel piksel) çözünürlüğünde mi geliyor?
//      (Electron'da tek bir thumbnailSize tüm çağrıya uygulandığı için düşük
//       çözünürlüklü ekranlar upscale-downscale ile bulanıklaşıyordu; capture-service.js
//       bunu monitör başına ayrı getSources() ile çözüyor. xcap'ta bu sorun olmamalı.)
//   2. İLK yakalama boş geliyor mu? (macOS ScreenCaptureKit ısınma sorunu —
//      Electron'da 5 denemeli retry döngüsünün varlık sebebi.)
//   3. Yakalama süresi ne kadar? (Electron: ~200-400ms/monitör ölçüldü)
//   4. PNG encode süresi + boyut.

use std::time::Instant;

fn main() {
    let out_dir = std::env::args().nth(1).unwrap_or_else(|| "./out".into());
    std::fs::create_dir_all(&out_dir).expect("çıktı dizini");

    let monitors = xcap::Monitor::all().expect("monitörler listelenemedi");
    println!("Bulunan monitör: {}\n", monitors.len());

    // Soru 2: peş peşe 3 tur — ilk turun boş/karanlık gelip gelmediğini görmek için.
    for round in 1..=2 {
        println!("── Tur {round} ──────────────────────────────");
        for (i, m) in monitors.iter().enumerate() {
            let name = m.name().unwrap_or_else(|_| format!("monitor-{i}"));
            let scale = m.scale_factor().unwrap_or(1.0);
            let (mw, mh) = (m.width().unwrap_or(0), m.height().unwrap_or(0));

            let t0 = Instant::now();
            let img = match m.capture_image() {
                Ok(img) => img,
                Err(e) => { println!("  ❌ {name}: yakalama hatası: {e}"); continue; }
            };
            let capture_ms = t0.elapsed().as_secs_f64() * 1000.0;

            let (w, h) = (img.width(), img.height());
            // Soru 1: gelen görüntü fiziksel piksel mi?
            let expected_w = (mw as f64 * scale as f64).round() as u32;
            let native = w == expected_w || w == mw; // xcap sürümüne göre ikisi de olabilir

            // Soru 2: boş/tek renk mi? (Electron'daki thumbnail.isEmpty() karşılığı)
            let px = img.as_raw();
            let nonzero = px.iter().step_by(97).filter(|b| **b != 0).count();
            let sample = px.len() / 97;
            let blank = nonzero * 100 / sample.max(1) < 2;

            // ── Encode yolları ────────────────────────────────────────────────
            // Overlay'e gönderim için PNG'ye HİÇ gerek yok: ham RGBA doğrudan
            // ImageBitmap'e gider. PNG yalnız diske kaydederken / panoya
            // yazarken gerekli. Üçünü de ölçüyoruz.
            let raw_len = px.len();

            let t1 = Instant::now();
            let mut png_default: Vec<u8> = Vec::new();
            {
                use image::ImageEncoder;
                image::codecs::png::PngEncoder::new(&mut png_default)
                    .write_image(px, w, h, image::ExtendedColorType::Rgba8)
                    .expect("png");
            }
            let png_default_ms = t1.elapsed().as_secs_f64() * 1000.0;

            let t2 = Instant::now();
            let mut png_fast: Vec<u8> = Vec::new();
            {
                use image::ImageEncoder;
                use image::codecs::png::{CompressionType, FilterType, PngEncoder};
                PngEncoder::new_with_quality(&mut png_fast, CompressionType::Fast, FilterType::NoFilter)
                    .write_image(px, w, h, image::ExtendedColorType::Rgba8)
                    .expect("png fast");
            }
            let png_fast_ms = t2.elapsed().as_secs_f64() * 1000.0;

            let t3 = Instant::now();
            let mut jpg: Vec<u8> = Vec::new();
            {
                use image::ImageEncoder;
                let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 85)
                    .write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
                    .expect("jpeg");
            }
            let jpg_ms = t3.elapsed().as_secs_f64() * 1000.0;

            if round == 1 {
                std::fs::write(format!("{out_dir}/mon{i}_{w}x{h}.png"), &png_default).ok();
            }

            println!(
                "  {} {name}\n     monitör={mw}x{mh} @{scale}x → beklenen fiziksel {expected_w}px\n     \
                 yakalanan={w}x{h} {}   boş={}\n     \
                 capture={capture_ms:.0}ms\n     \
                 ham RGBA   : {:>7.1}MB   encode=0ms  ← overlay'e giden yol\n     \
                 PNG (varsay): {:>7.1}MB   encode={png_default_ms:.0}ms\n     \
                 PNG (fast)  : {:>7.1}MB   encode={png_fast_ms:.0}ms\n     \
                 JPEG q85    : {:>7.1}MB   encode={jpg_ms:.0}ms",
                if blank { "❌" } else { "✅" },
                if native { "✅ yerel çözünürlük" } else { "⚠ ÖLÇEKLENMİŞ" },
                if blank { "EVET ❌" } else { "hayır" },
                raw_len as f64 / 1_048_576.0,
                png_default.len() as f64 / 1_048_576.0,
                png_fast.len() as f64 / 1_048_576.0,
                jpg.len() as f64 / 1_048_576.0,
            );
        }
        println!();
    }

    println!("Çıktılar: {out_dir}");
    println!("→ r1_* ile r3_* dosyalarını karşılaştırın: ilk tur boş/karanlıksa retry döngüsü gerekir.");
    println!("→ Farklı DPI'lı iki monitörde her ikisi de keskin mi, göz ile doğrulayın.");
}
