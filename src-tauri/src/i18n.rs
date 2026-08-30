//! Arayüz dili. Türkçe KAYNAK dildir: koddaki her metin Türkçe yazılır ve aynı zamanda
//! kendi arama anahtarıdır. Karşılığı olmayan bir anahtar ham bir tanımlayıcı değil,
//! Türkçesi olarak görünür — yani eksik bir sözlük hiçbir ekranı bozamaz.
//!
//! Sözlük binary'ye gömülüdür (`include_str!`): birkaç KB, ve preload'un senkron
//! `sendSync('i18n-get')` çağrısının yerini alan `initialization_script` bunu pencere
//! kurulurken enjekte ediyor — dosya okuması için beklenecek bir an yok.

use serde_json::Value;
use std::sync::OnceLock;

use crate::store::Store;

pub const SUPPORTED: [&str; 2] = ["tr", "en"];

const EN_JSON: &str = include_str!("../../src/shared/i18n/en.json");

fn en_dict() -> &'static Value {
    static D: OnceLock<Value> = OnceLock::new();
    D.get_or_init(|| serde_json::from_str(EN_JSON).unwrap_or_else(|e| {
        log::error!("en.json ayrıştırılamadı: {e}");
        Value::Object(Default::default())
    }))
}

/// Türkçe, KASITLI olarak — OS yereli DEĞİL. Uygulama bugüne dek yalnız Türkçeydi;
/// sistem dilini izlemek, güncellemeyle birlikte mevcut her kullanıcıyı İngilizceye
/// çevirirdi. İngilizce Ayarlar'da tek tık uzakta.
pub fn detect_default() -> &'static str {
    "tr"
}

pub fn get_language(store: &Store) -> String {
    let saved: String = store.get("language", String::new());
    if SUPPORTED.contains(&saved.as_str()) {
        saved
    } else {
        detect_default().to_string()
    }
}

pub fn set_language(store: &Store, lang: &str) -> bool {
    if !SUPPORTED.contains(&lang) || lang == get_language(store) {
        return false;
    }
    store.set("language", lang);
    true
}

/// Pencerelere gönderilen sözlük. `tr` için boş — her anahtar zaten Türkçe.
pub fn dict_for(lang: &str) -> Value {
    match lang {
        "en" => en_dict().clone(),
        _ => Value::Object(Default::default()),
    }
}

/// `t("Kaydet")` → "Save" · `t_vars("Hata: {error}", &[("error", &e)])`
pub fn t(store: &Store, turkish: &str) -> String {
    let lang = get_language(store);
    dict_for(&lang)
        .get(turkish)
        .and_then(|v| v.as_str())
        .unwrap_or(turkish)
        .to_string()
}

pub fn t_vars(store: &Store, turkish: &str, vars: &[(&str, &str)]) -> String {
    fill(&t(store, turkish), vars)
}

/// `{name}` yer tutucularını doldurur — JS tarafındaki `fill()` ile aynı davranış:
/// karşılığı olmayan yer tutucu OLDUĞU GİBİ kalır (sessizce silinmez).
fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        match rest[start..].find('}') {
            Some(end) => {
                let key = &rest[start + 1..start + end];
                match vars.iter().find(|(k, _)| *k == key) {
                    Some((_, v)) => out.push_str(v),
                    None => out.push_str(&rest[start..=start + end]),
                }
                rest = &rest[start + end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn en_sozlugu_gomulu_ve_gecerli() {
        assert!(en_dict().is_object(), "en.json bir nesne olmalı");
        assert!(
            en_dict().as_object().unwrap().len() > 10,
            "en.json beklenenden çok küçük — include_str! yanlış dosyayı mı aldı?"
        );
    }

    #[test]
    fn yer_tutucu_doldurma() {
        assert_eq!(fill("Hata: {error}", &[("error", "disk dolu")]), "Hata: disk dolu");
        // Karşılığı olmayan yer tutucu KALIR — sessizce silinmez
        assert_eq!(fill("Merhaba {ad}", &[]), "Merhaba {ad}");
        assert_eq!(fill("{a} ve {b}", &[("a", "1"), ("b", "2")]), "1 ve 2");
        assert_eq!(fill("kapanmamış {", &[]), "kapanmamış {");
        assert_eq!(fill("düz metin", &[]), "düz metin");
    }
}
