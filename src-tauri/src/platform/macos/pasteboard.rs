//! macOS pano erişimi — `NSPasteboard`.
//!
//! `arboard` yerine doğrudan NSPasteboard kullanılıyor, iki sebeple:
//!
//! 1. **`changeCount`.** Pano değişmediyse metni okumaya hiç gerek yok. Electron sürümü
//!    saniyede bir `clipboard.readText()` çağırıyordu; büyük bir kopya varsa bu, her
//!    saniye megabaytların kopyalanması demek. `changeCount` bir tam sayı karşılaştırması.
//!
//! 2. **Gizli pano tespiti.** Parola yöneticileri ve gizli mod tarayıcıları, içeriğin
//!    pano geçmişine düşmemesi için sentinel tipler yazar (nspasteboard.org fiilî
//!    standardı). `arboard` bunları göremez; `NSPasteboard.types` görür.
//!
//! Bu davranışı KAYBETMEK gerçek bir güvenlik gerilemesidir — bu yüzden başarısızlık
//! hâlinde `is_concealed` `true` DEĞİL `false` döner: tespit çalışmıyorsa yakalamaya
//! devam ederiz (Electron sürümündeki `fails safe` yorumuyla aynı seçim).

use objc2::rc::autoreleasepool;
use objc2::AnyThread;
use objc2_app_kit::{NSBitmapImageRep, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
use objc2_foundation::{NSData, NSString};

/// nspasteboard.org fiilî standardı.
/// `ConcealedType`: parola gibi hassas içerik.
/// `TransientType`: "birazdan üzerine yazılacak" içerik (otomatik doldurma ara adımı).
const CONCEALED_TYPES: [&str; 2] = [
    "org.nspasteboard.ConcealedType",
    "org.nspasteboard.TransientType",
];

/// Pano her değiştiğinde artan sayaç. Değişmediyse okuma yapmaya gerek yok.
pub fn change_count() -> i64 {
    autoreleasepool(|_| NSPasteboard::generalPasteboard().changeCount() as i64)
}

/// İçerik, bir parola yöneticisi tarafından "geçmişe alma" diye işaretlenmiş mi?
///
/// Metni OKUMADAN ÖNCE sorulmalı.
pub fn is_concealed() -> bool {
    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        let Some(types) = pb.types() else { return false };
        types.iter().any(|t| {
            let s = t.to_string();
            CONCEALED_TYPES.contains(&s.as_str())
        })
    })
}

/// Panodaki düz metin. Metin yoksa (resim, dosya) `None`.
pub fn read_text() -> Option<String> {
    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        let ty = NSString::from_str("public.utf8-plain-text");
        pb.stringForType(&ty).map(|s| s.to_string())
    })
}

/// Panoya düz metin yazar. Önceki içeriği temizler (Electron `writeText` davranışı).
pub fn write_text(text: &str) -> bool {
    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let ty = NSString::from_str("public.utf8-plain-text");
        pb.setString_forType(&NSString::from_str(text), &ty)
    })
}

/// Panoya bir PNG görseli yazar: PNG baytları olduğu gibi, yanına TIFF (PNG'yi
/// tanımayan eski alıcılar için — Electron `clipboard.writeImage` de ikisini yazıyordu).
///
/// ## Neden `arboard::set_image` değil
///
/// arboard pikselleri bir `CGDataProvider`'a sarıp `NSImage` yapıyor ve panoya
/// `writeObjects:` ile NESNE veriyor. O NSImage (ve altındaki ham piksel tamponu)
/// yazımdan sonra serbest kalmıyordu — autorelease pool'una sarınca bile, her kopyada
/// piksel tamponu kadar bellek kalıyordu. Ölçüldü (6 gün açık release, `vmmap`):
/// 7 kopyadan ~230 MB; 2000×2000 testinde kopya başına +15 MB.
///
/// Burada panoya VERİ veriliyor (`setData:forType:`): baytlar pano sunucusuna
/// kopyalanıyor, bizim tarafta tutulan nesne kalmıyor. PNG zaten elimizde (renderer
/// onu üretiyor), dolayısıyla çözme + yeniden kodlama da gerekmiyor.
///
/// Her çağıran thread'den güvenli: tüm AppKit nesneleri bu fonksiyonun pool'unda.
pub fn write_png(png: &[u8]) -> Result<(), String> {
    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let data = NSData::with_bytes(png);
        if !pb.setData_forType(Some(&data), unsafe { NSPasteboardTypePNG }) {
            return Err("NSPasteboard setData(PNG) false döndü".into());
        }
        // TIFF en iyi çabayla: PNG çözülemiyorsa yalnız PNG kalır, hata değil.
        let tiff = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &data)
            .and_then(|rep| rep.TIFFRepresentation());
        if let Some(tiff) = tiff {
            if !pb.setData_forType(Some(&tiff), unsafe { NSPasteboardTypeTIFF }) {
                log::warn!("panoya TIFF yazılamadı — yalnız PNG var");
            }
        } else {
            log::warn!("PNG AppKit tarafından çözülemedi — panoda yalnız PNG var");
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSArray;

    /// Genel pano tek ve paylaşılan: `cargo test` testleri paralel koşturduğu için
    /// buradaki testler birbirinin yazdığını okuyordu, NSBitmapImageRep + NSPasteboard'a
    /// eşzamanlı erişim ise SIGSEGV veriyordu (ölçüldü: paralel 3/3 başarısız,
    /// `--test-threads=1` 3/3 geçti). Pano'ya dokunan her test bu kilidi alır.
    static PANO: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn pano_kilidi() -> std::sync::MutexGuard<'static, ()> {
        PANO.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Panoya, bir parola yöneticisinin yazacağı gibi gizli-tip işaretli içerik yazar.
    fn write_concealed(text: &str) {
        autoreleasepool(|_| {
            let pb = NSPasteboard::generalPasteboard();
            let plain = NSString::from_str("public.utf8-plain-text");
            let concealed = NSString::from_str("org.nspasteboard.ConcealedType");
            let types = NSArray::from_retained_slice(&[plain.clone(), concealed.clone()]);
            pb.clearContents();
            unsafe { pb.declareTypes_owner(&types, None) };
            pb.setString_forType(&NSString::from_str(text), &plain);
            pb.setString_forType(&NSString::from_str(""), &concealed);
        });
    }

    /// Gizli pano tespiti — parola yöneticisi içeriğinin geçmişe düşmemesi bu
    /// fonksiyona bağlı. Kaybolursa gerçek bir güvenlik gerilemesi olur, ve sessizce
    /// kaybolur: normal kopyalar çalışmaya devam eder.
    ///
    /// Test kullanıcının panosunu geçici olarak değiştiriyor; sonunda geri yazıyor.
    #[test]
    fn gizli_pano_tespiti() {
        let _kilit = pano_kilidi();
        let saved = read_text();

        write_text("düz metin, gizli değil");
        assert!(!is_concealed(), "normal içerik gizli sayıldı — her şey geçmişe girmez olurdu");
        assert_eq!(read_text().as_deref(), Some("düz metin, gizli değil"));

        write_concealed("süper-gizli-parola");
        assert!(
            is_concealed(),
            "org.nspasteboard.ConcealedType tanınmadı — parolalar geçmişe düşerdi"
        );

        // Normale dönüş: bayrak yapışıp kalmamalı, yoksa gizli bir kopyadan sonra
        // hiçbir şey yakalanmaz olurdu.
        write_text("yine normal");
        assert!(!is_concealed(), "gizli bayrağı bir sonraki kopyaya taşındı");

        if let Some(s) = saved {
            write_text(&s);
        }
    }

    #[test]
    fn change_count_kopyada_artiyor() {
        let _kilit = pano_kilidi();
        // İzleyicinin tamamı buna dayanıyor: sayaç değişmiyorsa metin hiç okunmuyor.
        let before = change_count();
        write_text("sayaç testi");
        let after = change_count();
        assert!(after > before, "changeCount artmadı ({before} → {after})");
    }

    /// Görsel yazımı: PNG birebir geri okunmalı, TIFF de yanında olmalı.
    /// Panoyu değiştirir; sonunda metni geri yazar.
    #[test]
    fn png_yazimi_iki_tiple_geri_okunuyor() {
        let _kilit = pano_kilidi();
        let saved = read_text();

        // 2×2 kırmızı PNG (image crate ile kodlanmış, geçerli bir dosya).
        let mut png = Vec::new();
        {
            use image::ImageEncoder;
            image::codecs::png::PngEncoder::new(&mut png)
                .write_image(&[255, 0, 0, 255].repeat(4), 2, 2, image::ExtendedColorType::Rgba8)
                .unwrap();
        }
        write_png(&png).expect("png yazılamadı");

        let (png_back, tiff_len) = autoreleasepool(|_| {
            let pb = NSPasteboard::generalPasteboard();
            let p = pb.dataForType(unsafe { NSPasteboardTypePNG }).map(|d| d.to_vec());
            let t = pb.dataForType(unsafe { NSPasteboardTypeTIFF }).map(|d| d.len());
            (p, t)
        });
        assert_eq!(png_back.as_deref(), Some(png.as_slice()), "PNG birebir geri gelmedi");
        assert!(tiff_len.unwrap_or(0) > 0, "TIFF temsili yok — PNG tanımayan alıcılar boş kalırdı");
        assert!(read_text().is_none(), "görsel yazımından sonra panoda metin kalmamalı");

        if let Some(s) = saved {
            write_text(&s);
        }
    }
}
