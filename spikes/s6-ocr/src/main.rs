// S6 spike — tesseract-rs (eng+tur gömülü) mevcut tesseract.js kalitesini veriyor mu?
//
// Ölçülenler:
//   1. Build gerçekten eng+tur verisini gömüyor mu, ağdan bir şey çekmeden çalışıyor mu?
//   2. İlk init süresi (tesseract.js'te ~1-2sn worker warmup vardı)
//   3. Tanıma süresi ve doğruluk (Electron çıktısıyla elle karşılaştırılacak)
//   4. Bellek: tesseract.js worker'ı 150MB+ RSS tutuyordu; buradaki ne?

use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("kullanım: s6-ocr <görüntü.png> [<görüntü2.png> ...]");
        std::process::exit(2);
    }

    let t0 = Instant::now();
    let api = tesseract_rs::TesseractAPI::new();
    let init_new_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── BULGU S6-a ───────────────────────────────────────────────────────────
    // `embed-tessdata` feature'ı VARSAYILAN DEĞİL (default = ["build-tesseract"]),
    // açıkça açılmalı. Açıldığında TESSERACT_EMBED_LANGUAGES varsayılanı "eng,tur"
    // olduğu için ikisi de binary'ye gömülüyor.
    //
    // ── BULGU S6-b ───────────────────────────────────────────────────────────
    // api.init_embedded(lang) TEK dil alır — EMBEDDED_TESSDATA bir HashMap ve
    // "tur+eng" diye bir anahtar yok. CopyBoard ise iki dili BİRLİKTE tanıyor
    // (bugünkü tesseract.js çağrısı: createWorker('eng+tur')).
    // Çözüm: gömülü blob'ları ilk çalıştırmada bir kez diske yaz, sonra normal
    // çok dilli init() kullan. Paket hâlâ sıfır ek dosya taşıyor.
    let langs = tesseract_rs::embedded_languages();
    println!("gömülü diller       = {:?}", langs);

    let dir = std::env::temp_dir().join("copyboard-tessdata");
    std::fs::create_dir_all(&dir).expect("tessdata dizini");
    let mut embedded_bytes = 0usize;
    for lang in ["eng", "tur"] {
        let blob = tesseract_rs::get_embedded_tessdata(lang)
            .unwrap_or_else(|| panic!("{lang} gömülü değil"));
        embedded_bytes += blob.len();
        let f = dir.join(format!("{lang}.traineddata"));
        if !f.exists() || std::fs::metadata(&f).map(|m| m.len() as usize).unwrap_or(0) != blob.len() {
            std::fs::write(&f, blob).expect("traineddata yazılamadı");
            println!("  {lang}.traineddata yazıldı ({:.1} MB)", blob.len() as f64 / 1_048_576.0);
        }
    }
    println!("gömülü toplam       = {:.1} MB", embedded_bytes as f64 / 1_048_576.0);

    let t1 = Instant::now();
    api.init(&dir, "tur+eng").expect("init(tur+eng) başarısız");
    let init_ms = t1.elapsed().as_secs_f64() * 1000.0;

    println!("TesseractAPI::new() = {init_new_ms:.0}ms");
    println!("init(tur+eng)       = {init_ms:.0}ms");
    println!("tesseract sürümü    = {}", tesseract_rs::TesseractAPI::version());
    println!();

    for path in &args[1..] {
        let img = match image::open(path) {
            Ok(i) => i.to_luma8(),
            Err(e) => { eprintln!("❌ {path}: {e}"); continue; }
        };
        let (w, h) = (img.width() as i32, img.height() as i32);

        let t = Instant::now();
        api.set_image(img.as_raw(), w, h, 1, w).expect("set_image");
        let text = api.get_utf8_text().unwrap_or_default();
        let ms = t.elapsed().as_secs_f64() * 1000.0;

        let trimmed = text.trim();
        println!("── {path}  ({w}x{h})  {ms:.0}ms  {} karakter", trimmed.chars().count());
        println!("{}", trimmed);
        println!();
    }

    // Bellek (macOS): ru_maxrss byte cinsinden
    #[cfg(unix)]
    {
        let mut usage: libc_rusage = unsafe { std::mem::zeroed() };
        if unsafe { getrusage(0, &mut usage) } == 0 {
            println!("peak RSS = {:.1} MB", usage.ru_maxrss as f64 / 1_048_576.0);
        }
    }
}

#[cfg(unix)]
#[repr(C)]
#[derive(Clone, Copy)]
struct libc_rusage {
    ru_utime: [i64; 2],
    ru_stime: [i64; 2],
    ru_maxrss: i64,
    _rest: [i64; 14],
}

#[cfg(unix)]
extern "C" {
    fn getrusage(who: i32, usage: *mut libc_rusage) -> i32;
}
