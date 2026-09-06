//! Optik karakter tanıma.
//!
//! ## Electron'a göre ne silindi
//!
//! `capture-handlers.js`'te ~150 satırlık bir worker yaşam döngüsü vardı: `createWorker`
//! promise'inin hiç çözülmemesine karşı zaman aşımı, `recognize`'ın hiç çözülmemesine
//! karşı ikinci bir zaman aşımı, ölen worker thread'ini yakalamak için `exit` dinleyicisi,
//! 150 MB'lık worker'ı 5 dakika sonra bırakan boşta zamanlayıcı, ve `langPath` yerine
//! `cachePath` kullanmayı gerektiren bir tesseract.js tuhaflığı. Hepsi gitti.
//!
//! Burada OCR senkron bir kütüphane çağrısı; `spawn_blocking` ile ana thread'den uzakta
//! koşuyor. Başarısız olursa `Result` döner.
//!
//! ## Dil verisi
//!
//! `eng` + `tur` binary'ye GÖMÜLÜ (crate'in `embed-tessdata` özelliği). Ağa hiç
//! çıkılmıyor, `extraResources` yok.
//!
//! ### BULGU S6-b — `init_embedded` tek dil alıyor
//!
//! Gömülü veri bir `HashMap<&str, &[u8]>` ve `"tur+eng"` diye bir anahtar yok; CopyBoard
//! ise iki dili BİRLİKTE tanıyor (`createWorker('eng+tur')`). Çözüm: blob'ları ilk
//! çalıştırmada bir kez diske yazıp normal çok dilli `init()` kullanmak. Paket hâlâ
//! sıfır ek dosya taşıyor.

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::Manager;

/// Gömülü dil verisinin bir kez yazıldığı dizin.
fn tessdata_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("tessdata")
}

/// Gömülü blob'ları diske serer (yalnız eksik ya da boyutu tutmayanları).
///
/// Yalnız BAŞARI önbelleğe alınıyor. İlk hâli sonucu `OnceLock`'a koyuyordu; tek bir
/// geçici hata (disk dolu, izin) OCR'ı uygulama yeniden başlatılana dek öldürüyordu.
/// Electron sürümü de başarısız worker promise'ini sıfırlayıp yeniden deniyordu.
fn ensure_tessdata(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    static READY: OnceLock<PathBuf> = OnceLock::new();
    if let Some(dir) = READY.get() {
        return Ok(dir.clone());
    }
    let dir = tessdata_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("tessdata dizini: {e}"))?;
    for lang in ["eng", "tur"] {
        let blob = tesseract_rs::get_embedded_tessdata(lang)
            .ok_or_else(|| format!("'{lang}' verisi binary'de gömülü değil"))?;
        let file = dir.join(format!("{lang}.traineddata"));
        let needs_write = std::fs::metadata(&file)
            .map(|m| m.len() as usize != blob.len())
            .unwrap_or(true);
        if needs_write {
            std::fs::write(&file, blob).map_err(|e| format!("{lang}.traineddata: {e}"))?;
            log::info!("{lang}.traineddata yazıldı ({:.1} MB)", blob.len() as f64 / 1_048_576.0);
        }
    }
    let _ = READY.set(dir.clone());
    Ok(dir)
}

/// PNG baytlarından metin çıkarır. Bloklayıcı — çağıran `spawn_blocking` kullanmalı.
pub fn recognize_png(app: &tauri::AppHandle, png: &[u8]) -> Result<String, String> {
    let dir = ensure_tessdata(app)?;
    recognize_with_dir(&dir, png)
}

/// Dil verisi dizini AÇIKÇA verilen hâl — `AppHandle` olmadan test edilebilsin diye ayrı.
pub fn recognize_with_dir(dir: &std::path::Path, png: &[u8]) -> Result<String, String> {
    // Gri tonlama: Tesseract'ın beklediği biçim ve renk kanallarını taşımak boşuna iş.
    let img = image::load_from_memory(png)
        .map_err(|e| format!("görüntü çözülemedi: {e}"))?
        .to_luma8();
    let (w, h) = (img.width() as i32, img.height() as i32);
    if w == 0 || h == 0 {
        return Err("boş görüntü".into());
    }

    let api = tesseract_rs::TesseractAPI::new();
    // Sıra Electron ile aynı (`createWorker('eng+tur')`): Tesseract ilk dili birincil
    // sayıyor; farklı sıra karışık metinlerde farklı sonuç veriyor.
    api.init(dir, "eng+tur")
        .map_err(|e| format!("tesseract başlatılamadı: {e:?}"))?;
    api.set_image(img.as_raw(), w, h, 1, w)
        .map_err(|e| format!("görüntü verilemedi: {e:?}"))?;
    let text = api
        .get_utf8_text()
        .map_err(|e| format!("metin okunamadı: {e:?}"))?;

    Ok(text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gömülü dil verisini geçici bir dizine serer.
    ///
    /// Yol SÜREÇ KİMLİĞİ TAŞIMIYOR: veri binary'ye gömülü, yani her koşuda birebir
    /// aynı ve 22 MB. Kimlik taşıdığı sürece her `cargo test` koşusu yeni bir kopya
    /// bırakıyordu ve hiçbiri silinmiyordu — bu makinede 29 kopya, 632 MB. Sabit yol
    /// üstelik daha hızlı: boyut tutuyorsa yeniden yazılmıyor.
    ///
    /// Yazma ATOMİK (geçici ad + `rename`): iki test süreci aynı anda koşarsa biri
    /// diğerinin yarım yazdığı dosyayı okumasın.
    fn spread_tessdata() -> PathBuf {
        let dir = std::env::temp_dir().join("copyboard-ocr-testdata");
        std::fs::create_dir_all(&dir).unwrap();
        for lang in ["eng", "tur"] {
            let blob = tesseract_rs::get_embedded_tessdata(lang)
                .unwrap_or_else(|| panic!("'{lang}' binary'ye gömülü değil"));
            let f = dir.join(format!("{lang}.traineddata"));
            if std::fs::metadata(&f).map(|m| m.len() as usize != blob.len()).unwrap_or(true) {
                let tmp = dir.join(format!("{lang}.{}.part", std::process::id()));
                std::fs::write(&tmp, blob).unwrap();
                std::fs::rename(&tmp, &f).unwrap();
            }
        }
        dir
    }

    #[test]
    fn eng_ve_tur_binaryye_gomulu() {
        // Türkçe verisi düşerse OCR sessizce yalnız İngilizce tanır ve Türkçe
        // aksanlar bozulur — kullanıcının fark etmesi zor bir gerileme.
        for lang in ["eng", "tur"] {
            let blob = tesseract_rs::get_embedded_tessdata(lang);
            assert!(blob.is_some(), "'{lang}' gömülü değil");
            assert!(blob.unwrap().len() > 1_000_000, "'{lang}' verisi şüpheli derecede küçük");
        }
    }

    #[test]
    fn cok_dilli_init_ve_bos_goruntu() {
        // `init_embedded` tek dil aldığı için (BULGU S6-b) blob'ları diske serip
        // çok dilli init kullanıyoruz. Bu testin işi o yolun çalıştığını göstermek.
        let dir = spread_tessdata();
        let mut png = Vec::new();
        {
            use image::ImageEncoder;
            let img = image::GrayImage::from_pixel(64, 32, image::Luma([255u8]));
            image::codecs::png::PngEncoder::new(&mut png)
                .write_image(img.as_raw(), 64, 32, image::ExtendedColorType::L8)
                .unwrap();
        }
        // Boş bir görüntü HATA değil, boş METİN döndürmeli — "metin bulunamadı"
        // ile "tanıma çöktü" kullanıcıya farklı şeyler söylüyor.
        let text = recognize_with_dir(&dir, &png).expect("boş görüntü hata vermemeli");
        assert!(text.is_empty(), "boş görüntüden metin çıktı: {text:?}");
    }

    #[test]
    fn bozuk_png_hata_veriyor_panik_atmiyor() {
        let dir = spread_tessdata();
        let err = recognize_with_dir(&dir, b"bu bir png degil").unwrap_err();
        assert!(err.contains("çözülemedi"), "beklenmeyen hata: {err}");
    }
}
