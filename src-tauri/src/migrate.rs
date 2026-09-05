//! Electron (v2.x) kullanıcı verisinin Tauri (v3) dizinine göçü + açılış sanitizasyonu.
//!
//! **Temel kural: KOPYALA, TAŞIMA.** Electron dizinine hiç dokunulmuyor. Kullanıcı v3'ten
//! memnun kalmazsa v2.12.0'ı yeniden kurup kaldığı yerden devam edebilmeli. Göç bir kez
//! çalışır ve `migratedFrom` işaretiyle kendini idempotent kılar.
//!
//! Yollar (Electron `app.getName()` = "copyboard" kullanıyordu; Tauri bundle identifier'ı):
//!
//! | | Electron | Tauri |
//! |---|---|---|
//! | macOS | `~/Library/Application Support/copyboard` | `~/Library/Application Support/com.nurullahyayan.copyboard` |
//! | Windows | `%APPDATA%\copyboard` | `%APPDATA%\com.nurullahyayan.copyboard` |
//! | Linux | `~/.config/copyboard` | `~/.config/com.nurullahyayan.copyboard` |

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::store::Store;

pub const MIGRATION_MARKER: &str = "migratedFrom";

/// Electron sürümünün veri dizini. Yalnız OKUMAK için.
fn electron_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    {
        home.map(|h| h.join("Library/Application Support/copyboard"))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = home;
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("copyboard"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".config")))
            .map(|c| c.join("copyboard"))
    }
}

pub struct MigrationReport {
    pub performed: bool,
    pub reason: &'static str,
    pub history: usize,
    pub favorites: usize,
    pub screenshots_copied: usize,
    pub screenshots_missing: usize,
}

/// Tauri dizininde `config.json` YOKSA ve Electron'da VARSA, veriyi kopyalar.
/// Tauri config'i zaten varsa hiçbir şey yapmaz.
pub fn migrate_from_electron(tauri_dir: &Path) -> MigrationReport {
    let none = |reason| MigrationReport {
        performed: false,
        reason,
        history: 0,
        favorites: 0,
        screenshots_copied: 0,
        screenshots_missing: 0,
    };

    let target_config = tauri_dir.join("config.json");
    if target_config.exists() {
        return none("hedefte config.json zaten var");
    }
    let Some(src_dir) = electron_dir() else {
        return none("Electron dizini belirlenemedi");
    };
    let src_config = src_dir.join("config.json");
    if !src_config.exists() {
        return none("temiz kurulum — Electron verisi yok");
    }

    let text = match std::fs::read_to_string(&src_config) {
        Ok(t) => t,
        Err(e) => {
            log::error!("Electron config.json okunamadı: {e}");
            return none("Electron config.json okunamadı");
        }
    };
    let mut data: Map<String, Value> = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => m,
        _ => {
            log::error!("Electron config.json geçerli bir JSON nesnesi değil — göç atlandı");
            return none("Electron config.json bozuk");
        }
    };

    let history = data.get("history").and_then(|v| v.as_array()).map_or(0, |a| a.len());
    let favorites = data.get("favorites").and_then(|v| v.as_array()).map_or(0, |a| a.len());

    // ── Ekran görüntüsü dosyaları ────────────────────────────────────────────
    // İndeks (`screenshots`) mutlak dosya yolları taşıyor; dizin değiştiği için
    // hem dosyalar kopyalanmalı hem de yollar yeniden yazılmalı.
    let src_shots = src_dir.join("screenshots");
    let dst_shots = tauri_dir.join("screenshots");
    let mut copied = 0usize;
    let mut missing = 0usize;

    if let Some(Value::Array(items)) = data.get_mut("screenshots") {
        if !items.is_empty() {
            let _ = std::fs::create_dir_all(&dst_shots);
        }
        items.retain_mut(|item| {
            let Some(obj) = item.as_object_mut() else { return false };
            let Some(old) = obj.get("file").and_then(|v| v.as_str()).map(PathBuf::from) else {
                return false;
            };
            let Some(name) = old.file_name() else { return false };
            let new = dst_shots.join(name);

            if !old.exists() {
                // Kullanıcı dosyayı uygulama dışından silmiş — indeksten de düşür.
                missing += 1;
                return false;
            }
            match std::fs::copy(&old, &new) {
                Ok(_) => {
                    copied += 1;
                    obj.insert("file".into(), json!(new.to_string_lossy()));
                    true
                }
                Err(e) => {
                    log::error!("ekran görüntüsü kopyalanamadı ({}): {e}", old.display());
                    missing += 1;
                    false
                }
            }
        });
        let _ = src_shots; // yalnız okundu; kaynak dizine dokunulmadı
    }

    // ── Monitör kimliği ──────────────────────────────────────────────────────
    // Electron `display.id` bir sayı; Tauri monitörleri isimle tanıyor. Sayıyı
    // taşımanın anlamı yok — alanı düşürüyoruz. `widgetPos` + `ensureWidgetInBounds`
    // widget'ı zaten kurtarıyor, yalnız ilk açılışta hangi monitör olduğunu
    // hatırlamayabilir.
    if let Some(Value::Object(dock)) = data.get_mut("widgetDockParams") {
        dock.remove("displayId");
    }

    data.insert(
        MIGRATION_MARKER.into(),
        json!({ "from": "electron", "at": now_iso(), "history": history, "favorites": favorites }),
    );

    if let Err(e) = write_json(&target_config, &Value::Object(data)) {
        log::error!("göç edilen config.json yazılamadı: {e}");
        return none("hedef config.json yazılamadı");
    }

    log::info!(
        "Electron verisi göç etti: {history} geçmiş, {favorites} favori, {copied} ekran görüntüsü \
         ({missing} atlandı). Kaynak dizine dokunulmadı: {}",
        src_dir.display()
    );

    MigrationReport {
        performed: true,
        reason: "göç tamamlandı",
        history,
        favorites,
        screenshots_copied: copied,
        screenshots_missing: missing,
    }
}

/// `state.js`'in açılışta yaptığı düzeltmeler. Göçten bağımsız, HER açılışta koşar —
/// eski bir kurulumdan gelen veri de, göç edilmiş veri de aynı şekilde onarılır.
///
/// 1. Düz string olan geçmiş/favori kayıtları nesneye çevrilir.
/// 2. `id`'si olmayan kayıtlara id verilir (sürükle-sırala ve silme id'ye dayanıyor).
/// 3. `favorites` hiç yoksa, `history` içindeki `isFavorite: true` kayıtlardan üretilir
///    ve `isFavorite`/`hiddenFromHistory` bayrakları geçmişten temizlenir.
pub fn sanitize(store: &Store) {
    let mut history: Vec<Value> = store.get("history", Vec::new());
    let mut history_changed = normalize_items(&mut history);

    let existing_favorites = store.get_value("favorites");
    let mut favorites: Vec<Value> = match existing_favorites {
        Some(Value::Array(a)) => a,
        _ => {
            // İlk kez: eski `isFavorite` bayraklarından üret.
            let derived: Vec<Value> = history
                .iter()
                .filter(|i| i.get("isFavorite").and_then(|v| v.as_bool()).unwrap_or(false))
                .map(|i| {
                    json!({
                        "id": new_id(),
                        "content": i.get("content").cloned().unwrap_or(json!("")),
                        "timestamp": i.get("timestamp").cloned().unwrap_or(json!(now_iso())),
                    })
                })
                .collect();
            for item in history.iter_mut() {
                if let Some(o) = item.as_object_mut() {
                    if o.remove("isFavorite").is_some() | o.remove("hiddenFromHistory").is_some() {
                        history_changed = true;
                    }
                }
            }
            store.set("favorites", &derived);
            derived
        }
    };

    if normalize_items(&mut favorites) {
        store.set("favorites", &favorites);
    }
    if history_changed {
        store.set("history", &history);
    }
}

/// String kayıtları nesneye çevirir, eksik id'leri tamamlar. Değişiklik olduysa `true`.
fn normalize_items(items: &mut Vec<Value>) -> bool {
    let mut changed = false;
    for item in items.iter_mut() {
        match item {
            Value::String(s) => {
                *item = json!({ "id": new_id(), "content": s, "timestamp": now_iso() });
                changed = true;
            }
            Value::Object(o)
                if !o.contains_key("id") => {
                    o.insert("id".into(), json!(new_id()));
                    changed = true;
                }
            _ => {}
        }
    }
    changed
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `new Date().toISOString()` biçimi — geçmiş kayıtları JS tarafında bu biçimde okunuyor.
pub fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let ms = d.subsec_millis();

    // Sivil takvim dönüşümü (Howard Hinnant'ın days_from_civil'inin tersi).
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d_ = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d_, rem / 3600, (rem % 3600) / 60, rem % 60, ms
    )
}

fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(value)?)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_zaman_damgasi_js_bicimiyle_ayni() {
        let s = now_iso();
        assert_eq!(s.len(), 24, "beklenen biçim: 1970-01-01T00:00:00.000Z, gelen: {s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
        // Yıl makul aralıkta mı (saat dilimi/epoch hatasını yakalar)
        let year: i32 = s[0..4].parse().unwrap();
        assert!((2024..2100).contains(&year), "yıl {year} anlamsız");
    }

    #[test]
    fn string_kayitlar_nesneye_cevrilir() {
        let mut items = vec![json!("düz metin"), json!({ "content": "id'siz" })];
        assert!(normalize_items(&mut items));
        assert_eq!(items[0]["content"], json!("düz metin"));
        assert!(items[0]["id"].is_string());
        assert!(items[1]["id"].is_string());
    }

    #[test]
    fn eksiksiz_kayitlar_degistirilmez() {
        let mut items = vec![json!({ "id": "abc", "content": "x", "timestamp": "t" })];
        assert!(!normalize_items(&mut items));
        assert_eq!(items[0]["id"], json!("abc"));
    }
}
