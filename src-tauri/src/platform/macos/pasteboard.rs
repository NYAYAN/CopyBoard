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
use objc2_app_kit::NSPasteboard;
use objc2_foundation::NSString;

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

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSArray;

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
        // İzleyicinin tamamı buna dayanıyor: sayaç değişmiyorsa metin hiç okunmuyor.
        let before = change_count();
        write_text("sayaç testi");
        let after = change_count();
        assert!(after > before, "changeCount artmadı ({before} → {after})");
    }
}
