//! Pano geçmişi ve favoriler — `src/main/services/history-manager.js`'in karşılığı.
//!
//! Geçmiş ve favoriler TAMAMEN AYRI listeler: geçmişi temizlemek favorilere dokunmaz.
//!
//! Kayıtlar `serde_json::Value` olarak taşınıyor, struct olarak değil. Sebebi store ile
//! aynı: renderer bu nesneleri olduğu gibi alıp `note` gibi isteğe bağlı alanlarla geri
//! veriyor; katı bir struct tanımadığı alanı sessizce düşürürdü.

use serde_json::{json, Value};
use tauri::Manager;

use crate::state::AppState;
use crate::store::Store;

/// Geçmiş yayınlarının gittiği pencereler. Yalnız GÖRÜNÜR olanlara gider — gizli
/// pencereler gösterildiklerinde veriyi kendileri tazeliyor, ve her pano kopyasında
/// ~0,5 MB geçmişi üç pencereye itmek saf israftı.
pub const SUBSCRIBERS: [&str; 3] = ["main", "widget", "quickpaste"];

/// Kayıtlar BÜTÜN hâlde saklanır ya da hiç saklanmaz — asla kırpılmaz, çünkü kırpılmış
/// bir kayıt ilerideki bir yapıştırmada sessizce bozuk içerik üretirdi. Bundan büyük
/// kopyalar listeye hiç girmez (işletim sisteminin panosu etkilenmez).
///
/// Bu eşik aynı zamanda config dosyasını sınırlı tutuyor: dosya her değişiklikte
/// baştan yazılıyor ve açılışta okunuyor.
/// Electron `content.length`i sayıyordu — yani JS'in UTF-16 KOD BİRİMİ sayısını.
/// `str::len()` ise UTF-8 BAYTI sayar: Türkçe harfler 2, CJK 3, emoji 4 bayt.
/// Bayt saymak, Electron'da rahatça geçen bir metni Tauri'de sessizce reddeder —
/// tam Türkçe bir metinde eşik fiilen yarıya iner.
const MAX_ITEM_CHARS: usize = 1_000_000;

/// JS `String.length` ile aynı: UTF-16 kod birimi sayısı.
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

// ── Okuma ────────────────────────────────────────────────────────────────────

pub fn history(store: &Store) -> Vec<Value> {
    store.get("history", Vec::new())
}

pub fn favorites(store: &Store) -> Vec<Value> {
    store.get("favorites", Vec::new())
}

/// Renderer'ın beklediği yük: `{ history, favorites }`.
pub fn snapshot(store: &Store) -> Value {
    json!({ "history": history(store), "favorites": favorites(store) })
}

// ── Yayın ────────────────────────────────────────────────────────────────────

/// Tek bir pencereye anlık görüntü gönderir (pencere görünür olduğunda tazeleme).
pub fn push_snapshot(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<AppState>();
    crate::windows::emit_to(app, label, "update-history", snapshot(&state.store));
}

/// Görünür tüm abonelere yayınlar.
pub fn broadcast(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    crate::windows::emit_to_visible(app, &SUBSCRIBERS, "update-history", snapshot(&state.store));
}

// ── Yazma ────────────────────────────────────────────────────────────────────

fn content_of(item: &Value) -> Option<&str> {
    item.get("content").and_then(|c| c.as_str())
}

/// Yeni bir kopyayı geçmişe ekler.
///
/// Aynı içerik zaten varsa kayıt BAŞA taşınır — ama eski kaydın NOTU korunur:
/// tekilleştirme kaydı yeniden yarattığı için, not aktarılmazsa kullanıcının
/// "Müşteri Mail Taslağı" notu bir kopyala hareketiyle sessizce silinirdi.
pub fn add(app: &tauri::AppHandle, content: &str) {
    if content.is_empty() || utf16_len(content) > MAX_ITEM_CHARS {
        return;
    }
    let state = app.state::<AppState>();
    let max = state.settings().max_items().max(1) as usize;

    // Oku-değiştir-yaz TEK kilit altında: `get` + `set` ayrı alınırsa, kullanıcı bu
    // sırada arayüzden bir kayıt silerse silme sessizce geri alınır.
    state.store.update("history", Vec::<Value>::new(), |items: &mut Vec<Value>| {
        let previous_note = items
            .iter()
            .position(|i| content_of(i) == Some(content))
            .and_then(|idx| {
                let note = items[idx].get("note").cloned();
                items.remove(idx);
                note
            });

        let mut entry = json!({
            "id": new_id(),
            "content": content,
            "timestamp": crate::migrate::now_iso(),
        });
        if let Some(note) = previous_note {
            if !note.as_str().unwrap_or("").is_empty() {
                entry["note"] = note;
            }
        }
        items.insert(0, entry);
        items.truncate(max);
        true
    });
    broadcast(app);
}

pub fn delete(app: &tauri::AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let mut removed = false;
    state.store.update("history", Vec::<Value>::new(), |items: &mut Vec<Value>| {
        let before = items.len();
        items.retain(|i| i.get("id").and_then(|v| v.as_str()) != Some(id));
        removed = items.len() != before;
        removed
    });
    if removed {
        broadcast(app);
    }
}

pub fn clear(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.store.set("history", Vec::<Value>::new());
    broadcast(app);
    let msg = crate::i18n::t(&state.store, "Geçmiş Temizlendi.");
    crate::windows::toast::show(app, &msg, "success");
}

/// `maxItems` küçültüldüğünde listeyi kırpar.
pub fn trim_to_max(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let max = state.settings().max_items().max(1) as usize;
    let mut trimmed = false;
    state.store.update("history", Vec::<Value>::new(), |items: &mut Vec<Value>| {
        trimmed = items.len() > max;
        if trimmed {
            items.truncate(max);
        }
        trimmed
    });
    if trimmed {
        broadcast(app);
    }
}

// ── Favoriler ────────────────────────────────────────────────────────────────

/// Aynı içerik zaten favorilerdeyse hiçbir şey yapmaz (Electron davranışı).
pub fn add_favorite(app: &tauri::AppHandle, item: &Value) {
    let state = app.state::<AppState>();
    if add_favorite_in_store(&state.store, item) {
        broadcast(app);
    }
}

/// Saf hâl — `AppHandle` olmadan test edilebilsin diye ayrı. Eklendiyse `true`.
fn add_favorite_in_store(store: &Store, item: &Value) -> bool {
    let Some(content) = content_of(item) else { return false };
    let mut added = false;
    store.update("favorites", Vec::<Value>::new(), |favs: &mut Vec<Value>| {
        if favs.iter().any(|f| content_of(f) == Some(content)) {
            return false; // aynı içerik zaten favorilerde
        }
        favs.insert(
            0,
            json!({
                "id": new_id(),
                "content": content,
                "timestamp": crate::migrate::now_iso(),
                "note": item.get("note").and_then(|n| n.as_str()).unwrap_or(""),
            }),
        );
        added = true;
        true
    });
    added
}

pub fn remove_favorite(app: &tauri::AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let mut removed = false;
    state.store.update("favorites", Vec::<Value>::new(), |favs: &mut Vec<Value>| {
        let before = favs.len();
        favs.retain(|f| f.get("id").and_then(|v| v.as_str()) != Some(id));
        removed = favs.len() != before;
        removed
    });
    if removed {
        broadcast(app);
    }
}

/// Not, aynı id'ye sahip kayıt HANGİ listedeyse oraya yazılır — bir kayıt hem
/// geçmişte hem favorilerde aynı id ile bulunabilir mi diye bakmaz, ikisini de dener
/// (Electron sürümü de öyle yapıyordu).
pub fn set_note(app: &tauri::AppHandle, id: &str, note: &str) {
    let state = app.state::<AppState>();
    let mut touched = false;

    for key in ["favorites", "history"] {
        state.store.update(key, Vec::<Value>::new(), |items: &mut Vec<Value>| {
            let mut changed = false;
            for item in items.iter_mut() {
                if item.get("id").and_then(|v| v.as_str()) == Some(id) {
                    item["note"] = json!(note);
                    changed = true;
                }
            }
            touched |= changed;
            changed
        });
    }
    if touched {
        broadcast(app);
    }
}

/// Sürükle-bırak sıralaması. Renderer tüm listeyi yeni sırasıyla geri gönderiyor.
///
/// Gelen liste, kayıt SAYISI bakımından doğrulanıyor: bir render hatası yüzünden
/// gelen kısa bir liste, kullanıcının geçmişini sessizce silerdi.
pub fn reorder(app: &tauri::AppHandle, key: &str, incoming: Vec<Value>) {
    let state = app.state::<AppState>();
    if reorder_in_store(&state.store, key, incoming) {
        broadcast(app);
    }
}

/// Sıralamanın saf hâli — `AppHandle` olmadan test edilebilsin diye ayrı.
/// Kabul edildiyse `true`.
fn reorder_in_store(store: &Store, key: &str, incoming: Vec<Value>) -> bool {
    let current: Vec<Value> = store.get(key, Vec::new());
    if incoming.len() != current.len() {
        log::warn!(
            "{key} yeniden sıralaması reddedildi: {} kayıt bekleniyordu, {} geldi",
            current.len(),
            incoming.len()
        );
        return false;
    }
    store.set(key, &incoming);
    true
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn store() -> Arc<Store> {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "copyboard-hist-test-{}-{:?}.json",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&p);
        Store::load(p)
    }

    /// `add()` bir AppHandle istiyor (yayın için); saf mantığı ayrı test etmek için
    /// aynı adımları store üzerinde yürüten bir yardımcı.
    fn add_pure(store: &Store, content: &str, max: usize) {
        if content.is_empty() || utf16_len(content) > MAX_ITEM_CHARS {
            return;
        }
        let mut items: Vec<Value> = store.get("history", Vec::new());
        let previous_note = items
            .iter()
            .position(|i| content_of(i) == Some(content))
            .map(|idx| {
                let note = items[idx].get("note").cloned();
                items.remove(idx);
                note
            })
            .flatten();
        let mut entry = json!({ "id": new_id(), "content": content, "timestamp": "t" });
        if let Some(note) = previous_note {
            if !note.as_str().unwrap_or("").is_empty() {
                entry["note"] = note;
            }
        }
        items.insert(0, entry);
        items.truncate(max);
        store.set("history", &items);
    }

    #[test]
    fn ayni_icerik_basa_tasinir_kopyalanmaz() {
        let s = store();
        add_pure(&s, "bir", 50);
        add_pure(&s, "iki", 50);
        add_pure(&s, "bir", 50);
        let h = history(&s);
        assert_eq!(h.len(), 2, "tekilleştirme çalışmadı");
        assert_eq!(content_of(&h[0]), Some("bir"));
        assert_eq!(content_of(&h[1]), Some("iki"));
    }

    #[test]
    fn yeniden_kopyalamak_notu_silmiyor() {
        // Bu davranış kaybolursa, kullanıcının "Müşteri Mail Taslağı" notu bir
        // kopyala hareketiyle sessizce yok olur.
        let s = store();
        add_pure(&s, "taslak", 50);
        let mut h = history(&s);
        h[0]["note"] = json!("Müşteri Mail Taslağı");
        s.set("history", &h);

        add_pure(&s, "taslak", 50);
        let h = history(&s);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0]["note"], json!("Müşteri Mail Taslağı"));
    }

    #[test]
    fn max_items_asildiginda_en_eski_dusuyor() {
        let s = store();
        for i in 0..5 {
            add_pure(&s, &format!("kayıt-{i}"), 3);
        }
        let h = history(&s);
        assert_eq!(h.len(), 3);
        assert_eq!(content_of(&h[0]), Some("kayıt-4"));
        assert_eq!(content_of(&h[2]), Some("kayıt-2"));
    }

    #[test]
    fn cok_buyuk_kayit_hic_girmiyor() {
        // Kırpma YOK: ya bütün girer ya hiç. Kırpılmış bir kayıt ilerideki bir
        // yapıştırmada sessizce bozuk içerik üretirdi.
        let s = store();
        let huge = "x".repeat(MAX_ITEM_CHARS + 1);
        add_pure(&s, &huge, 50);
        assert!(history(&s).is_empty());

        let ok = "y".repeat(MAX_ITEM_CHARS);
        add_pure(&s, &ok, 50);
        assert_eq!(history(&s).len(), 1);
    }

    #[test]
    fn esik_utf16_kod_birimi_sayiyor_bayt_degil() {
        // Electron `content.length` (UTF-16) sayıyordu. Bayt saymak, tam Türkçe bir
        // metinde eşiği fiilen yarıya indirir ve Electron'da geçen bir kayıt
        // Tauri'de sessizce reddedilirdi.
        let turkce = "ğ".repeat(MAX_ITEM_CHARS); // UTF-8'de 2 bayt, UTF-16'da 1 birim
        assert!(turkce.len() > MAX_ITEM_CHARS, "test kurgusu: bayt sayısı eşiği aşmalı");
        assert_eq!(utf16_len(&turkce), MAX_ITEM_CHARS);

        let s = store();
        add_pure(&s, &turkce, 50);
        assert_eq!(history(&s).len(), 1, "Electron'da geçen Türkçe metin reddedildi");
    }

    #[test]
    fn favori_ayni_icerikle_iki_kez_eklenmiyor() {
        let s = store();
        assert!(add_favorite_in_store(&s, &json!({ "content": "aynı", "note": "ilk" })));
        // İkinci kez: reddedilmeli ve İLK kaydın notu bozulmamalı
        assert!(!add_favorite_in_store(&s, &json!({ "content": "aynı", "note": "ikinci" })));

        let favs = favorites(&s);
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0]["note"], json!("ilk"), "mevcut favorinin notu ezildi");
    }

    #[test]
    fn favori_icerigi_olmayan_kayit_eklenmiyor() {
        let s = store();
        assert!(!add_favorite_in_store(&s, &json!({ "id": "x" })));
        assert!(favorites(&s).is_empty());
    }

    #[test]
    fn yanlis_uzunluktaki_siralama_reddedilir_dogrusu_kabul_edilir() {
        // Renderer'da bir hata yüzünden gelen KISA bir liste, geçmişi sessizce silerdi.
        let s = store();
        add_pure(&s, "a", 50);
        add_pure(&s, "b", 50);
        add_pure(&s, "c", 50);
        let original: Vec<Value> = s.get("history", Vec::new());
        assert_eq!(original.len(), 3);

        // Eksik liste → reddedilir, geçmiş dokunulmadan kalır
        let short = vec![original[0].clone()];
        assert!(!reorder_in_store(&s, "history", short));
        assert_eq!(history(&s).len(), 3, "reddedilen sıralama geçmişi bozdu");

        // Fazla liste → reddedilir
        let mut long = original.clone();
        long.push(original[0].clone());
        assert!(!reorder_in_store(&s, "history", long));
        assert_eq!(history(&s).len(), 3);

        // Doğru uzunlukta, ters sıra → kabul edilir ve gerçekten uygulanır
        let mut reversed = original.clone();
        reversed.reverse();
        assert!(reorder_in_store(&s, "history", reversed));
        let after = history(&s);
        assert_eq!(content_of(&after[0]), Some("a"), "sıralama uygulanmadı");
        assert_eq!(content_of(&after[2]), Some("c"));
    }
}
