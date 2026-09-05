//! Kaydedilen videoların indeksi ve küçük resimleri.
//!
//! ## Neden indeks
//!
//! Video, kaydetme panelinde kullanıcının seçtiği yere yazılıyor — yani nerede
//! olduğunu uygulama bilmiyordu. Ekran görüntüleri için zaten bir indeks vardı
//! (`screenshots`), videoların karşılığı yoktu: kullanıcı kaydını uygulama içinden
//! bir daha bulamıyordu.
//!
//! İndeks yalnızca YOL tutuyor, dosyayı kopyalamıyor. Kullanıcı dosyayı Finder'dan
//! taşır ya da silerse girdi listeden düşüyor ([`public_list`] her okumada var
//! olmayanları eliyor) — uygulama, kendi kopyasını saklayıp diskte iki katı yer
//! kaplamıyor.

/// Kayıtların yazıldığı dizin — ekran görüntülerinin `screenshots` klasörünün
/// karşılığı.
///
/// Uygulama verisinin yanında, kullanıcının Filmler klasöründe DEĞİL: video burada
/// uygulamanın yönettiği bir varlık (galeriden listeleniyor, siliniyor). Kullanıcının
/// kendi klasörüne karışmak, sildiğimizde onun dosyasını silmek anlamına gelirdi.
/// Dışarı almak isteyen "Klasörde Göster" ile taşıyabiliyor.
pub fn videos_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("videos")
}

use serde_json::{json, Value};
use tauri::Manager;

use crate::state::AppState;
use crate::store::Store;

/// İndekste en fazla bu kadar video tutuluyor. Girdiler küçük (yol + küçük resim),
/// ama sınırsız büyümesi de anlamsız.
const MAX_VIDEOS: usize = 200;

pub fn items(store: &Store) -> Vec<Value> {
    store.get("videos", Vec::new())
}

/// Renderer'a giden liste: dosyası SİLİNMİŞ girdiler elenmiş hâli.
///
/// Eleme okuma anında yapılıyor, yazma anında değil: kullanıcı dosyayı Finder'dan
/// silmiş olabilir ve bunu ancak listeye bakarken fark ederiz.
pub fn public_list(store: &Store) -> Vec<Value> {
    items(store)
        .into_iter()
        .filter(|v| {
            v.get("file")
                .and_then(Value::as_str)
                .is_some_and(|f| std::path::Path::new(f).exists())
        })
        .collect()
}

pub fn broadcast(app: &tauri::AppHandle) {
    let list = public_list(&app.state::<AppState>().store);
    crate::windows::emit_to_visible(
        app,
        &[crate::windows::main_window::LABEL],
        "update-videos",
        list,
    );
}

/// Kaydedilen bir videoyu indekse ekler.
///
/// Küçük resim ve süre çıkarma diske ve AVFoundation'a gidiyor; bu yüzden çağıran
/// bunu ARKA PLANDA yapmalı — kaydetme panelinin geri çağrısını bekletmemeli.
pub fn add(app: &tauri::AppHandle, path: &std::path::Path) {
    let file = path.to_string_lossy().to_string();
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let (thumb, duration, w, h) = probe(path);

    let state = app.state::<AppState>();
    state.store.update("videos", Vec::<Value>::new(), |list: &mut Vec<Value>| {
        // Aynı yol yeniden kaydedilirse (üzerine yazma) girdi tekrarlanmasın.
        list.retain(|v| v.get("file").and_then(Value::as_str) != Some(file.as_str()));
        list.insert(
            0,
            json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "file": file,
                "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "timestamp": crate::migrate::now_iso(),
                "bytes": bytes,
                "duration": duration,
                "w": w,
                "h": h,
                "thumb": thumb,
            }),
        );
        list.truncate(MAX_VIDEOS);
        true
    });
    broadcast(app);
}

/// İndeksten düşürür; `with_file` ise dosyayı da siler.
pub fn delete(app: &tauri::AppHandle, id: &str, with_file: bool) {
    let state = app.state::<AppState>();
    let mut removed = false;
    state.store.update("videos", Vec::<Value>::new(), |list: &mut Vec<Value>| {
        let Some(pos) = list.iter().position(|v| v.get("id").and_then(Value::as_str) == Some(id))
        else {
            return false;
        };
        if with_file {
            if let Some(f) = list[pos].get("file").and_then(Value::as_str) {
                // Zaten yoksa sorun değil — indeks tek doğru kaynak.
                let _ = std::fs::remove_file(f);
            }
        }
        list.remove(pos);
        removed = true;
        true
    });
    if removed {
        broadcast(app);
    }
}

pub fn by_id(store: &Store, id: &str) -> Option<Value> {
    items(store)
        .into_iter()
        .find(|v| v.get("id").and_then(Value::as_str) == Some(id))
}

// ── Küçük resim + süre ───────────────────────────────────────────────────────

/// Videodan küçük resim, süre ve boyut çıkarır. Başarısızlıkta boş küçük resim ve
/// sıfır süre döner — kayıt listede yine görünmeli, yalnız görseli olmaz.
#[cfg(target_os = "macos")]
fn probe(path: &std::path::Path) -> (String, f64, u32, u32) {
    match macos_probe(path) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("video küçük resmi çıkarılamadı ({}): {e}", path.display());
            (String::new(), 0.0, 0, 0)
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn probe(_path: &std::path::Path) -> (String, f64, u32, u32) {
    (String::new(), 0.0, 0, 0)
}

/// Apple bu iki çağrıyı asenkron karşılıkları lehine "deprecated" işaretledi
/// (`loadTracksWithMediaType:`, `generateCGImageAsynchronouslyForTime:`). Asenkron
/// sürümler tamamlanma bloğu istiyor; bu fonksiyon ZATEN kendi arka plan thread'inde
/// çalıştığı için blok kurup beklemek yalnızca kod ekler, hiçbir şey kazandırmaz.
/// Bloklayan sürüm burada doğru araç.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn macos_probe(path: &std::path::Path) -> Result<(String, f64, u32, u32), String> {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_av_foundation::{AVAsset, AVAssetImageGenerator, AVMediaTypeVideo, AVURLAsset};
    use objc2_core_media::CMTime;
    use objc2_foundation::{NSString, NSURL};

    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let asset: Retained<AVURLAsset> =
            AVURLAsset::initWithURL_options(AVURLAsset::alloc(), &url, None);
        let duration = {
            let d: CMTime = asset.duration();
            let (v, ts) = ({ d.value }, { d.timescale });
            if ts > 0 { v as f64 / f64::from(ts) } else { 0.0 }
        };

        // Videonun GERÇEK çözünürlüğü. Küçük resmin boyutundan okumak yanlış olurdu:
        // `setMaximumSize` onu 320'ye indiriyor ve kartta "320×180" yazardı.
        let (nat_w, nat_h) = AVMediaTypeVideo
            .and_then(|mt| asset.tracksWithMediaType(mt).iter().next().map(|t| t.naturalSize()))
            .map_or((0u32, 0u32), |sz| (sz.width as u32, sz.height as u32));

        let gen = AVAssetImageGenerator::initWithAsset(
            AVAssetImageGenerator::alloc(),
            &asset as &AVAsset,
        );
        // Kaydın döndürülmüş olma ihtimali için: küçük resim de dönmüş görünmeli.
        gen.setAppliesPreferredTrackTransform(true);
        // 320 px: kart 128 px genişliğinde gösteriyor, Retina'da 256. 480 px'lik
        // küçük resim 54 KB tutuyordu ve indeks 200 kayda kadar büyüyor — yani
        // yapılandırma dosyasına 10 MB. 320 px görsel olarak farksız, dörtte bir yer.
        gen.setMaximumSize(objc2_core_foundation::CGSize {
            width: 320.0,
            height: 320.0,
        });

        // Kareyi 1 SANİYEden alıyoruz, 0'dan değil: kaydın ilk anı çoğu zaman
        // menü kapanışı ya da boş ekran oluyor ve küçük resim hiçbir şey anlatmıyor.
        // Video 1 sn'den kısaysa ortasına düşülüyor.
        let t = if duration > 1.2 { 1.0 } else { duration / 2.0 };
        let time = CMTime {
            value: (t * 600.0) as i64,
            timescale: 600,
            flags: objc2_core_media::CMTimeFlags::Valid,
            epoch: 0,
        };
        let cg = gen
            .copyCGImageAtTime_actualTime_error(time, std::ptr::null_mut())
            .map_err(|e| format!("{e:?}"))?;

        let (tw, th) = (cg_width(&cg), cg_height(&cg));
        let thumb = cgimage_to_jpeg_data_url(&cg, tw, th)?;
        Ok((thumb, duration, nat_w, nat_h))
    }
}

#[cfg(target_os = "macos")]
mod cg {
    use std::ffi::c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        pub fn CGImageGetWidth(img: *const c_void) -> usize;
        pub fn CGImageGetHeight(img: *const c_void) -> usize;
        pub fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        pub fn CGColorSpaceRelease(cs: *mut c_void);
        pub fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: *mut c_void,
            bitmap_info: u32,
        ) -> *mut c_void;
        pub fn CGContextDrawImage(ctx: *mut c_void, rect: CGRectC, img: *const c_void);
        pub fn CGContextRelease(ctx: *mut c_void);
    }
    #[repr(C)]
    pub struct CGRectC {
        pub x: f64,
        pub y: f64,
        pub w: f64,
        pub h: f64,
    }
    /// kCGImageAlphaNoneSkipLast | kCGBitmapByteOrderDefault
    pub const ALPHA_NONE_SKIP_LAST: u32 = 5;
}

#[cfg(target_os = "macos")]
fn cg_width(img: &objc2_core_graphics::CGImage) -> usize {
    unsafe { cg::CGImageGetWidth((img as *const objc2_core_graphics::CGImage).cast()) }
}

#[cfg(target_os = "macos")]
fn cg_height(img: &objc2_core_graphics::CGImage) -> usize {
    unsafe { cg::CGImageGetHeight((img as *const objc2_core_graphics::CGImage).cast()) }
}

/// `CGImage` → JPEG data URL.
///
/// CGImage'i bir RGBA bitmap bağlamına çizip ham pikselleri okuyor, sonra `image`
/// crate'iyle JPEG'e sıkıştırıyor. ImageIO ile doğrudan da yapılabilirdi ama o yol
/// hedef biçim, sıkıştırma ve veri tüketimi için üç ayrı CoreFoundation nesnesi
/// gerektiriyor; galeri zaten aynı crate ile JPEG üretiyor, tek yol daha az kod.
#[cfg(target_os = "macos")]
fn cgimage_to_jpeg_data_url(
    img: &objc2_core_graphics::CGImage,
    w: usize,
    h: usize,
) -> Result<String, String> {
    if w == 0 || h == 0 {
        return Err("boş görüntü".into());
    }
    let stride = w * 4;
    let mut buf = vec![0u8; stride * h];
    unsafe {
        let space = cg::CGColorSpaceCreateDeviceRGB();
        let ctx = cg::CGBitmapContextCreate(
            buf.as_mut_ptr().cast(),
            w,
            h,
            8,
            stride,
            space,
            cg::ALPHA_NONE_SKIP_LAST,
        );
        cg::CGColorSpaceRelease(space);
        if ctx.is_null() {
            return Err("bitmap bağlamı kurulamadı".into());
        }
        cg::CGContextDrawImage(
            ctx,
            cg::CGRectC { x: 0.0, y: 0.0, w: w as f64, h: h as f64 },
            (img as *const objc2_core_graphics::CGImage).cast(),
        );
        cg::CGContextRelease(ctx);
    }

    // RGBA → RGB (alfa kanalı atlanıyor; JPEG zaten taşımıyor).
    let mut rgb = Vec::with_capacity(w * h * 3);
    for px in buf.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }

    let mut jpeg = Vec::new();
    {
        use image::ImageEncoder;
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 72)
            .write_image(&rgb, w as u32, h as u32, image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        crate::gallery::base64(&jpeg)
    ))
}
