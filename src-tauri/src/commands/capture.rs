//! Yakalama çıktıları: panoya kopyala, diske kaydet, renk kodu, OCR.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// Aynı anda tek kaydetme paneli. İkinci bir istek, birincinin arkasına bir panel daha
/// yığıyordu ve fazlalık, ilki kapandığında — ait olduğu andan çok sonra, kullanıcı o
/// sırada ne yapıyorsa onun üstünde — ortaya çıkıyordu.
static SAVE_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

/// `data:image/png;base64,...` → ham baytlar.
pub fn decode_data_url_pub(data_url: &str) -> Option<Vec<u8>> { decode_data_url(data_url) }

fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
    let b64 = data_url.split(',').nth(1)?;
    base64_decode(b64)
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
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

/// PNG'yi panoya resim olarak yazar.
///
/// Electron'da burada bir DPI telafisi vardı: renderer çıktıyı `devicePixelRatio` ile
/// çarpıyor, `clipboard.writeImage` ekran ölçeğine bölüyor, ikisi birbirini götürüyordu.
/// Burada öyle bir dönüşüm YOK — piksel neyse o. Mevcut kodun en kırılgan kısmı
/// böylece sadeleşiyor.
pub fn write_image_to_clipboard(png: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory(png).map_err(|e| format!("görüntü çözülemedi: {e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    arboard::Clipboard::new()
        .and_then(|mut c| {
            c.set_image(arboard::ImageData {
                width: w,
                height: h,
                bytes: std::borrow::Cow::Owned(rgba.into_raw()),
            })
        })
        .map_err(|e| format!("panoya yazılamadı: {e}"))
}

fn copy_png(app: &tauri::AppHandle, png: Vec<u8>) {
    match write_image_to_clipboard(&png) {
        Ok(()) => {
            // Galeri hatası kopyalamayı ASLA bozmasın — kopya zaten panoda.
            let _ = crate::gallery::add(app, &png);
            crate::windows::toast::show(app, "Resim Kopyalandı.", "success");
        }
        Err(e) => crate::windows::toast::show(app, &format!("Kopyalama Hatası: {e}"), "error"),
    }
    crate::capture::close_all(app, None);
}

/// Snipper'dan gelen data URL.
#[tauri::command]
pub fn snip_copy_image(app: tauri::AppHandle, data_url: String) {
    let Some(png) = decode_data_url(&data_url) else {
        crate::windows::toast::show(&app, "Kopyalama Hatası: görüntü çözülemedi", "error");
        crate::capture::close_all(&app, None);
        return;
    };
    copy_png(&app, png);
}

/// Kaydırmalı yakalamadan gelen HAM PNG. Birleştirilmiş bir sayfa onlarca megabayt
/// olabiliyor; base64 bunu üçte bir şişirir ve iki uçta da tam bir dize kopyası
/// gerektirirdi.
#[tauri::command]
pub fn snip_copy_buffer(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        crate::windows::toast::show(&app, "Kopyalama Hatası: ham veri bekleniyordu", "error");
        return;
    };
    copy_png(&app, bytes.clone());
}

/// Renk seçici kipi: overlay, artı imlecin altındaki hex'i gönderiyor. Bu bir resim
/// değil metin, o yüzden panoya ve geçmişe kopyalanan her dize gibi davranıyor.
#[tauri::command]
pub fn snip_copy_color(app: tauri::AppHandle, hex: String) {
    let value = hex.trim().to_lowercase();
    let valid = value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|c| c.is_ascii_hexdigit());
    if !valid {
        crate::windows::toast::show(&app, "Renk kopyalanamadı: geçersiz renk kodu", "error");
        crate::capture::close_all(&app, None);
        return;
    }
    {
        let state = app.state::<AppState>();
        state.runtime.lock().unwrap().last_text = value.clone();
    }
    crate::platform::clipboard_write_text(&value);
    crate::clipboard::history::add(&app, &value);
    crate::windows::toast::show(&app, &format!("Renk kodu kopyalandı: {value}"), "success");
    crate::capture::close_all(&app, None);
}

fn save_png(app: &tauri::AppHandle, png: Vec<u8>, prefix: &str) {
    if SAVE_DIALOG_OPEN.swap(true, Ordering::AcqRel) {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let default_name = format!("{prefix}_{stamp}.png");

    let pictures = app.path().picture_dir().ok();
    let handle = app.clone();

    // Renderer düğmesini panel gelene dek döndürüyor. Electron'da `showSaveDialog`
    // dönene kadar bloklanıyordu ve panelin gerçekten ekranda olduğu an ayrı bir
    // olayla (`sheet-begin`) ölçülüyordu. Tauri'de çağrı bloklamıyor, yani panel
    // isteği ile açılışı arasında ölçülebilir bir fark yok.
    crate::windows::emit_all(app, "save-dialog-open", ());

    let mut builder = app.dialog().file().set_file_name(&default_name).add_filter("Images", &["png"]);
    if let Some(dir) = pictures {
        builder = builder.set_directory(dir);
    }
    builder.save_file(move |path| {
        SAVE_DIALOG_OPEN.store(false, Ordering::Release);
        let Some(path) = path else {
            crate::windows::toast::show(&handle, "Kaydetme iptal edildi.", "info");
            return;
        };
        let Ok(p) = path.into_path() else {
            crate::windows::toast::show(&handle, "Kaydetme Hatası: geçersiz yol", "error");
            return;
        };
        match std::fs::write(&p, &png) {
            Ok(()) => {
                let _ = crate::gallery::add(&handle, &png);
                crate::windows::toast::show(&handle, "Resim Kaydedildi.", "success");
                crate::capture::close_all(&handle, None);
            }
            Err(e) => crate::windows::toast::show(&handle, &format!("Kaydetme Hatası: {e}"), "error"),
        }
    });
}

#[tauri::command]
pub fn snip_save_image(app: tauri::AppHandle, data_url: String) {
    let Some(png) = decode_data_url(&data_url) else {
        crate::windows::toast::show(&app, "Kaydetme Hatası: görüntü çözülemedi", "error");
        return;
    };
    save_png(&app, png, "snip");
}

#[tauri::command]
pub fn snip_save_buffer(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        crate::windows::toast::show(&app, "Kaydetme Hatası: ham veri bekleniyordu", "error");
        return;
    };
    save_png(&app, bytes.clone(), "scroll");
}

/// Metin tanıma. Görüntü verisi elde olduğu için overlay'ler ÖNCE kapanıyor.
#[tauri::command]
pub async fn ocr_process(app: tauri::AppHandle, data_url: String) {
    crate::capture::close_all(&app, None);
    crate::windows::toast::show(&app, "Metin Taranıyor...", "info");

    let Some(png) = decode_data_url(&data_url) else {
        crate::windows::toast::show(&app, "Metin tanıma başarısız oldu.", "error");
        return;
    };

    let handle = app.clone();
    // OCR saniyeler sürebiliyor; ana thread'den uzakta.
    let result = tauri::async_runtime::spawn_blocking(move || crate::ocr::recognize_png(&handle, &png)).await;

    match result {
        Ok(Ok(text)) if !text.is_empty() => {
            {
                let state = app.state::<AppState>();
                state.runtime.lock().unwrap().last_text = text.clone();
            }
            crate::platform::clipboard_write_text(&text);
            crate::clipboard::history::add(&app, &text);
            crate::windows::toast::show(&app, "Metin Kopyalandı.", "success");
        }
        Ok(Ok(_)) => crate::windows::toast::show(&app, "Metin bulunamadı.", "info"),
        Ok(Err(e)) => {
            log::error!("OCR başarısız: {e}");
            crate::windows::toast::show(&app, "Metin tanıma başarısız oldu.", "error");
        }
        Err(e) => {
            log::error!("OCR görevi düştü: {e}");
            crate::windows::toast::show(&app, "Metin tanıma başarısız oldu.", "error");
        }
    }
}

/// Overlay'i tıklama geçirgen yapar/kaldırır. Kaydedici ve kaydırmalı yakalama,
/// kullanıcının altındaki uygulamayla etkileşmesi için bunu kullanıyor.
#[tauri::command]
pub fn set_ignore_mouse_events(window: tauri::WebviewWindow, ignore: bool) {
    if let Err(e) = window.set_ignore_cursor_events(ignore) {
        log::warn!("tıklama geçirgenliği ayarlanamadı: {e}");
    }
}
