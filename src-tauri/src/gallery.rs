//! Ekran görüntüsü galerisi — `src/main/services/screenshot-library.js`'in karşılığı.
//!
//! Snipper'da tamamlanan görüntüler (panoya kopyalanan ya da diske kaydedilen) AYRICA
//! burada saklanıyor, böylece eski yakalamalar ana pencereden yeniden gezilebiliyor.
//! Tam PNG'ler `userData/screenshots` altında; küçük bir indeks — ızgarayı anında
//! çizmek için gömülü küçük resim data URL'iyle birlikte — store'da `screenshots`
//! anahtarında.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::Manager;

use crate::state::AppState;
use crate::store::Store;

pub(crate) const MAX_SCREENSHOTS: usize = 30;

/// Küçük resim, ızgaranın GERÇEKTEN çizdiği şekilde üretiliyor — hücre biçiminde,
/// kırpılmış, hücrenin CSS boyutunun iki katında — bir kutuya sığdırılarak değil.
///
/// Bir hücre 159×108 CSS piksel (350 px pencere, ızgaranın iki yandaki 12 px dolgusu ve
/// 8 px boşluğu düşülüp ikiye bölünmüş), yani 2x ekranda 318×216 AYGIT pikseli, ve img
/// `object-fit: cover`. Bir kutuya sığdırmak, ekran biçiminde OLMAYAN her şey için bu
/// tartışmayı fena hâlde kaybediyor: 766×8175'lik bir kaydırma yakalaması 360'a
/// sığdırıldığında 34×360 oluyor, cover da o 34 pikseli hücrenin 318'ine yaymak zorunda
/// kalıyor — dokuz kat. 220'de 785×16384'lük bir sayfa ON BİR piksel genişliğinde
/// çıkmıştı. Galerideki her kaydırma yakalaması bir bulaşıktı.
///
/// Yani: hedefi ÖRTECEK şekilde ölçekle, sonra ona kırp. Kırpma ÜSTTEN sabitleniyor,
/// çünkü bir sayfa ortasına düşen şeyle değil başlığıyla tanınır. Hiçbir şey
/// büyütülmüyor — hedeften küçük bir kaynak küçük kalıyor.
const THUMB_W: u32 = 360;
const THUMB_H: u32 = 245; // ~hücrenin 159:108'i, ızgaranın cover kırpmasına iş kalmasın

pub fn screenshots_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("screenshots")
}

fn items(store: &Store) -> Vec<Value> {
    store.get("screenshots", Vec::new())
}

/// Renderer'ın gördüğü alanlar — dosya yolu ve hash dışarı sızmıyor.
pub fn public_list(store: &Store) -> Vec<Value> {
    items(store)
        .into_iter()
        .map(|s| {
            json!({
                "id": s.get("id").cloned().unwrap_or(Value::Null),
                "timestamp": s.get("timestamp").cloned().unwrap_or(Value::Null),
                "w": s.get("w").cloned().unwrap_or(Value::Null),
                "h": s.get("h").cloned().unwrap_or(Value::Null),
                "thumb": s.get("thumb").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

pub fn broadcast(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    crate::windows::emit_to(app, "main", "screenshots-updated", public_list(&state.store));
}

/// Bu boyuttaki bir kaynak neye dönüşür — saf geometri.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThumbSize {
    /// Nihai (kırpılmış) boyut.
    pub w: u32,
    pub h: u32,
    /// Kırpmadan ÖNCEKİ ölçeklenmiş boyut.
    pub sw: u32,
    pub sh: u32,
}

pub fn thumb_size_for(w: u32, h: u32) -> ThumbSize {
    if w == 0 || h == 0 {
        return ThumbSize { w: 0, h: 0, sw: 0, sh: 0 };
    }
    // Ört, asla büyütme: hangi eksen kısaysa ölçeği o belirler.
    let scale = (THUMB_W as f64 / w as f64)
        .max(THUMB_H as f64 / h as f64)
        .min(1.0);
    let sw = ((w as f64 * scale).round() as u32).max(1);
    let sh = ((h as f64 * scale).round() as u32).max(1);
    ThumbSize { w: sw.min(THUMB_W), h: sh.min(THUMB_H), sw, sh }
}

/// Hedef kutuyu ört, sonra üstünü al. JPEG data URL döner.
fn make_thumb(png: &[u8]) -> Option<String> {
    let img = image::load_from_memory(png).ok()?;
    let (w, h) = (img.width(), img.height());
    let want = thumb_size_for(w, h);
    if want.sw == 0 {
        return None;
    }

    // Lanczos3: metnin temiz küçültülmesiyle yumuşak küçültülmesi arasındaki fark,
    // yakalama başına birkaç milisaniyeye mal oluyor.
    let scaled = img.resize_exact(want.sw, want.sh, image::imageops::FilterType::Lanczos3);
    let cropped = if want.w == want.sw && want.h == want.sh {
        scaled
    } else {
        // Yatayda ortalı, dikeyde ÜSTTEN — bir sayfayı başlığı tanıtır.
        scaled.crop_imm((want.sw - want.w) / 2, 0, want.w, want.h)
    };

    let mut jpeg = Vec::new();
    {
        use image::ImageEncoder;
        let rgb = cropped.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
            .write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .ok()?;
    }
    Some(format!("data:image/jpeg;base64,{}", base64(&jpeg)))
}

/// Eski/bozuk küçük resimleri arka planda yeniden üretir.
///
/// ## Neden gerekli
///
/// Küçük resim boyutu uygulamanın ömrü boyunca büyüdü. Eski sürümlerle kaydedilmiş
/// girdiler düşük çözünürlüklü küçük resim taşıyor ve galeride bulanık görünüyor;
/// bazılarının küçük resmi hiç yok (kaydetme sırasında kodlama başarısız olmuş).
/// Electron açılışta `upgradeThumbnails()` çağırıyordu, Tauri'de karşılığı yazılmamıştı —
/// yani v2'den göç eden HER kullanıcının galerisi bulanık kalıyordu.
///
/// Ölçüt Electron'unkiyle aynı: bir girdi, `thumb_size_for` KENDİ boyutları için ne
/// istiyorsa ondan küçük bir küçük resim taşıyorsa yenilenir. Orijinali zaten küçük
/// olan bir girdi böylece her açılışta boşuna yeniden işlenmiyor.
pub fn upgrade_thumbnails(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // Açılış telaşı geçsin: yakalama, OCR ve ilk çizim öncelikli.
        std::thread::sleep(std::time::Duration::from_millis(1500));

        let pending: Vec<String> = {
            let state = handle.state::<AppState>();
            items(&state.store)
                .iter()
                .filter(|s| needs_upgrade(s))
                .filter_map(|s| s.get("id")?.as_str().map(str::to_string))
                .collect()
        };
        if pending.is_empty() {
            return;
        }
        log::info!("{} küçük resim yenileniyor", pending.len());

        let mut repaired = 0usize;
        for id in pending {
            // Liste her adımda YENİDEN okunuyor: bu döngü saniyelerce sürebilir ve bu
            // sırada kullanıcı yakalama yapıp silebilir. Tek bir anlık görüntüyü
            // baştan sona tutmak o değişiklikleri geri alırdı.
            let state = handle.state::<AppState>();
            // Dosya okuma ve yeniden ölçekleme KİLİT DIŞINDA: bunlar yüz milisaniye
            // sürebilir ve o süre boyunca mağazayı kilitlemek arayüzü dondururdu.
            let Some(file) = items(&state.store)
                .iter()
                .find(|s| s.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .and_then(|s| s.get("file").and_then(Value::as_str).map(str::to_string))
            else {
                continue;
            };
            // Okunamayan dosya yenilenmeye değmez: eski küçük resmini korur,
            // `prune_missing()` sonunda ilgilenir.
            let Ok(bytes) = std::fs::read(&file) else {
                continue;
            };
            let Some(thumb) = make_thumb(&bytes) else {
                continue;
            };
            // Yazma anında listeyi kilit altında yeniden bul: kayıt bu arada
            // silinmiş olabilir, silinmişse geri getirmiyoruz.
            let mut written = false;
            state.store.update("screenshots", Vec::<Value>::new(), |list: &mut Vec<Value>| {
                let Some(item) = list
                    .iter_mut()
                    .find(|s| s.get("id").and_then(Value::as_str) == Some(id.as_str()))
                else {
                    return false;
                };
                item["thumb"] = Value::String(thumb);
                written = true;
                true
            });
            if written {
                repaired += 1;
            }

            // Nefes payı — galeri büyükse arayüzü aç kalmasın.
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        if repaired > 0 {
            log::info!("{repaired} küçük resim yenilendi");
            broadcast(&handle);
        }
    });
}

/// Bir girdinin küçük resmi, kendi boyutlarının hak ettiğinden küçük mü?
fn needs_upgrade(item: &Value) -> bool {
    let Some(thumb) = item.get("thumb").and_then(Value::as_str) else {
        return true; // küçük resim hiç yok
    };
    if thumb.is_empty() {
        return true;
    }
    let (Some(w), Some(h)) = (
        item.get("w").and_then(Value::as_u64),
        item.get("h").and_then(Value::as_u64),
    ) else {
        return false; // boyut bilinmiyor — ölçüt uygulanamaz, dokunma
    };
    let want = thumb_size_for(w as u32, h as u32);
    match decode_thumb_size(thumb) {
        Some((have_w, have_h)) => have_w < want.w || have_h < want.h,
        None => true, // çözülemeyen küçük resim bozuktur
    }
}

/// Bir data URL küçük resminin piksel boyutlarını, tamamını çözmeden okur.
fn decode_thumb_size(data_url: &str) -> Option<(u32, u32)> {
    let b64 = data_url.split(",").nth(1)?;
    let bytes = base64_decode(b64)?;
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .ok()?;
    reader.into_dimensions().ok()
}

/// Görüntüyü galeriye ekler ve girdiğinin id'sini döner.
pub fn add(app: &tauri::AppHandle, png: &[u8]) -> Option<String> {
    let state = app.state::<AppState>();
    let store = &state.store;
    let list = items(store);

    // Aynı görüntünün kopyala-sonra-kaydet'i art arda iki ekleme tetikliyor — bir kez indeksle.
    let hash = sha1_hex(png);
    if let Some(first) = list.first() {
        if first.get("hash").and_then(|h| h.as_str()) == Some(hash.as_str()) {
            return first.get("id").and_then(|i| i.as_str()).map(str::to_string);
        }
    }

    let dir = screenshots_dir(app);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::error!("galeri dizini oluşturulamadı: {e}");
        return None;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = dir.join(format!("snip_{stamp}_{}.png", &id[..8]));
    if let Err(e) = std::fs::write(&file, png) {
        log::error!("ekran görüntüsü yazılamadı: {e}");
        return None;
    }

    let (w, h) = image::load_from_memory(png)
        .map(|i| (i.width(), i.height()))
        .unwrap_or((0, 0));
    let thumb = make_thumb(png).unwrap_or_default();

    // Kilit ancak BURADA alınıyor: dosya yazma ve küçük resim üretimi yukarıda,
    // kilidin dışında bitti. `list` yalnızca tekilleştirme kontrolü içindi;
    // gerçek ekleme, araya giren bir silmeyi ezmemek için taze liste üzerinde.
    store.update("screenshots", Vec::<Value>::new(), |list: &mut Vec<Value>| {
        list.insert(
            0,
            json!({
                "id": id, "file": file.to_string_lossy(), "hash": hash,
                "timestamp": crate::migrate::now_iso(), "w": w, "h": h, "thumb": thumb,
            }),
        );
        while list.len() > MAX_SCREENSHOTS {
            if let Some(dropped) = list.pop() {
                if let Some(p) = dropped.get("file").and_then(|f| f.as_str()) {
                    // Zaten yoksa sorun değil — indeks tek doğru kaynak.
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        true
    });
    broadcast(app);
    Some(id)
}

pub fn by_id(store: &Store, id: &str) -> Option<Value> {
    items(store)
        .into_iter()
        .find(|s| s.get("id").and_then(|i| i.as_str()) == Some(id))
}

pub fn delete(app: &tauri::AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let mut removed = false;
    state.store.update("screenshots", Vec::<Value>::new(), |list: &mut Vec<Value>| {
        let Some(pos) = list
            .iter()
            .position(|s| s.get("id").and_then(|i| i.as_str()) == Some(id))
        else {
            return false;
        };
        if let Some(p) = list[pos].get("file").and_then(|f| f.as_str()) {
            let _ = std::fs::remove_file(p);
        }
        list.remove(pos);
        removed = true;
        true
    });
    if removed {
        broadcast(app);
    }
}

/// PNG'si uygulama dışından silinmiş/taşınmış indeks kayıtlarını düşürür ki ölü
/// küçük resimleri ızgarada asılı kalmasın.
pub fn prune_missing(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    let list = items(&state.store);
    let kept: Vec<Value> = list
        .iter()
        .filter(|s| {
            s.get("file")
                .and_then(|f| f.as_str())
                .map(|p| Path::new(p).exists())
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    if kept.len() == list.len() {
        return false;
    }
    state.store.set("screenshots", &kept);
    broadcast(app);
    true
}

fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// base64 çözer. Geçersiz karakterde `None`.
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kucuk_resim_ortuyor_sigdirmiyor() {
        // Bu testin varlık sebebi gerçek bir hata: bir kutuya SIĞDIRMAK, uzun kaydırma
        // yakalamalarını galeride 11 piksel genişliğinde bir bulaşığa çeviriyordu.
        let s = thumb_size_for(766, 8175);
        assert_eq!((s.w, s.h), (THUMB_W, THUMB_H), "uzun sayfa hücreyi örtmüyor");
        assert!(s.sw >= THUMB_W, "ölçeklenmiş genişlik hedefin altında: {}", s.sw);

        let s = thumb_size_for(785, 16384);
        assert_eq!((s.w, s.h), (THUMB_W, THUMB_H));
    }

    #[test]
    fn ekran_bicimli_goruntu_de_ortuyor() {
        let s = thumb_size_for(3600, 2338);
        assert_eq!((s.w, s.h), (THUMB_W, THUMB_H));
    }

    #[test]
    fn kucuk_kaynak_buyutulmuyor() {
        // Hedeften küçük bir kaynak küçük kalır — büyütmek yalnız bulanıklık üretir.
        let s = thumb_size_for(100, 80);
        assert_eq!((s.sw, s.sh), (100, 80));
        assert_eq!((s.w, s.h), (100, 80));
    }

    #[test]
    fn sifir_boyut_panik_atmiyor() {
        assert_eq!(thumb_size_for(0, 0), ThumbSize { w: 0, h: 0, sw: 0, sh: 0 });
        assert_eq!(thumb_size_for(100, 0).sw, 0);
    }

    #[test]
    fn base64_kodlamasi_dogru() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // Yüksek bitli baytlar (görüntü verisi böyle)
        assert_eq!(base64(&[0xff, 0xd8, 0xff]), "/9j/");
    }

    #[test]
    fn sha1_bilinen_deger() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }
}
