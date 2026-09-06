//! Arayüz teması. İki farklı değer var ve KASITLI olarak ayrı tutuluyor:
//!
//! | | |
//! |---|---|
//! | **MOD** | kullanıcının seçtiği — `dark` \| `light` \| `system` |
//! | **ÇÖZÜMLENMİŞ** | pencerenin gerçekten boyayacağı — `dark` \| `light` |
//!
//! Yalnız Ayarlar modu umursar; her pencereye çözümlenmiş değer gönderilir.
//!
//! Tema değişimi hiçbir şeyi YENİDEN YÜKLEMEZ (dilin aksine): her pencere bir olay alır
//! ve `<html>` üzerindeki `data-theme`'i çevirir. Geçiş anında olur ve iş ortasında
//! zararsızdır — alıntı overlay'i ve kaydedici, altınızdan yeniden yüklenmesini
//! gerçekten istemeyeceğiniz pencerelerdir.

use crate::store::Store;

pub const SUPPORTED: [&str; 3] = ["dark", "light", "system"];

/// Koyu, `system` değil: uygulama hep koyuydu ve bir güncelleme, kullanıcının
/// CopyBoard ile hiç ilişkilendirmediği bir OS ayarı yüzünden kendini yeniden
/// boyamamalı.
pub fn get_mode(store: &Store) -> String {
    let saved: String = store.get("theme", String::new());
    if SUPPORTED.contains(&saved.as_str()) {
        saved
    } else {
        "dark".into()
    }
}

pub fn set_mode(store: &Store, next: &str) -> bool {
    if !SUPPORTED.contains(&next) || next == get_mode(store) {
        return false;
    }
    store.set("theme", next);
    true
}

/// `system` modunda OS'un o anki görünümü; aksi hâlde modun kendisi.
pub fn resolved(store: &Store, os_is_dark: bool) -> String {
    let m = get_mode(store);
    if m != "system" {
        return m;
    }
    if os_is_dark { "dark".into() } else { "light".into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Yazıcı thread'i OLMADAN depo: geciktirilmiş bir yazma, geçici dosya
    /// silindikten sonra onu geri yaratıyordu (bkz. `testutil`).
    fn store() -> (std::sync::Arc<Store>, crate::testutil::TempPath) {
        let t = crate::testutil::TempPath::json("theme-test");
        (Store::load_without_writer(t.to_path_buf()), t)
    }

    #[test]
    fn varsayilan_koyu_os_ayarini_izlemez() {
        let (s, _tmp) = store();
        assert_eq!(get_mode(&s), "dark");
        // OS açık temada olsa bile mod 'system' değilse çözümlenen değişmez
        assert_eq!(resolved(&s, false), "dark");
        assert_eq!(resolved(&s, true), "dark");
    }

    #[test]
    fn system_modu_os_u_izler() {
        let (s, _tmp) = store();
        assert!(set_mode(&s, "system"));
        assert_eq!(resolved(&s, true), "dark");
        assert_eq!(resolved(&s, false), "light");
    }

    #[test]
    fn gecersiz_mod_reddedilir() {
        let (s, _tmp) = store();
        assert!(!set_mode(&s, "mor"));
        assert_eq!(get_mode(&s), "dark");
    }

    #[test]
    fn ayni_modu_yeniden_atamak_degisiklik_saymaz() {
        let (s, _tmp) = store();
        assert!(set_mode(&s, "light"));
        assert!(!set_mode(&s, "light"));
        let _: PathBuf = s.path().to_path_buf();
    }
}
