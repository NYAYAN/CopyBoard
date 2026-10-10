//! Yakalama çıktıları: panoya kopyala, diske kaydet, renk kodu, OCR.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// Aynı anda tek kaydetme paneli. İkinci bir istek, birincinin arkasına bir panel daha
/// yığıyordu ve fazlalık, ilki kapandığında — ait olduğu andan çok sonra, kullanıcı o
/// sırada ne yapıyorsa onun üstünde — ortaya çıkıyordu.
static SAVE_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

/// Yakalama oturumu bitince kilidi düşür. Panel overlay'e parent'lı; overlay panel
/// açıkken kapanırsa (Esc → `snip_close`) rfd geri çağrısı hiç gelmeyebiliyor ve
/// kilit takılı kalıyordu — sonraki her kaydetme sessizce no-op oluyordu. Electron
/// bunu `finally` ile sıfırlıyordu; burada `capture::finish()` çağırıyor.
pub fn reset_save_guard() {
    SAVE_DIALOG_OPEN.store(false, Ordering::Release);
}

/// `data:image/png;base64,...` → ham baytlar.
pub fn decode_data_url_pub(data_url: &str) -> Option<Vec<u8>> { decode_data_url(data_url) }

fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
    let b64 = data_url.split(',').nth(1)?;
    crate::gallery::base64_decode(b64)
}

/// PNG'yi panoya resim olarak yazar.
///
/// Electron'da burada bir DPI telafisi vardı: renderer çıktıyı `devicePixelRatio` ile
/// çarpıyor, `clipboard.writeImage` ekran ölçeğine bölüyor, ikisi birbirini götürüyordu.
/// Burada öyle bir dönüşüm YOK — piksel neyse o. Mevcut kodun en kırılgan kısmı
/// böylece sadeleşiyor.
pub fn write_image_to_clipboard(png: &[u8]) -> Result<(), String> {
    // Çağıran çoğu zaman bir tokio iş parçacığı (`copy_png` → `async_runtime::spawn`,
    // `async` komutlar). Eski yol (arboard → NSImage → `writeObjects:`) her kopyada
    // ham piksel tamponunu + TIFF'ini süreçte bırakıyordu: 6 gün açık release'te 7
    // görsel kopyasından ~230 MB (`vmmap`: Malloc Large + Foundation çiftleri; 3600×2338
    // ekranın tam kopyası 57 MB). `leaks` görmüyordu, çünkü nesneler referanslıydı.
    // Artık panoya nesne değil VERİ veriliyor — bkz. `platform::clipboard_write_png`.
    crate::platform::clipboard_write_png(png)
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
pub async fn snip_copy_image(app: tauri::AppHandle, data_url: String) {
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
    // `Request<'_>` ödünç aldığı için komut `async` olamıyor; baytlar kopyalanıp iş
    // runtime'a devrediliyor — pencere işleri IPC geri çağrısının içinde kalmasın
    // (Windows kilitlenmesi, bkz. `commands/mod.rs`).
    let bytes = bytes.clone();
    tauri::async_runtime::spawn(async move { copy_png(&app, bytes) });
}

/// Renk seçici kipi: overlay, artı imlecin altındaki hex'i gönderiyor. Bu bir resim
/// değil metin, o yüzden panoya ve geçmişe kopyalanan her dize gibi davranıyor.
#[tauri::command]
pub async fn snip_copy_color(app: tauri::AppHandle, hex: String) {
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

fn save_png(app: &tauri::AppHandle, window: Option<tauri::WebviewWindow>, png: Vec<u8>, prefix: &str) {
    if SAVE_DIALOG_OPEN.swap(true, Ordering::AcqRel) {
        log::warn!("kaydetme paneli zaten açık — {prefix} isteği yok sayıldı");
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let default_name = format!("{prefix}_{stamp}.png");

    let pictures = app.path().picture_dir().ok();
    let handle = app.clone();
    // Panel YERLİ (rfd/NSSavePanel) — açılmazsa ya da kullanıcı iptal ederse
    // uygulamada hiçbir iz kalmıyordu ve "Kaydet çalışmıyor" bildirimleri
    // günlükten doğrulanamıyordu. İstek ve sonuç artık yazılıyor.
    log::info!(
        "kaydetme paneli isteniyor: {default_name}, klasör {:?}, üst pencere {:?}",
        pictures.as_deref(),
        window.as_ref().map(|w| w.label().to_string())
    );

    // Renderer düğmesini panel gelene dek döndürüyor. Electron'da `showSaveDialog`
    // dönene kadar bloklanıyordu ve panelin gerçekten ekranda olduğu an ayrı bir
    // olayla (`sheet-begin`) ölçülüyordu. Tauri'de çağrı bloklamıyor, yani panel
    // isteği ile açılışı arasında ölçülebilir bir fark yok.
    crate::windows::emit_all(app, "save-dialog-open", ());

    // ── Panelin görünmesi ────────────────────────────────────────────────────
    // Electron'da bu, ölçümle bulunmuş bir hatanın düzeltmesiydi: panel yakalama
    // overlay'ine PARENT'lanmazsa (macOS'ta sheet olmazsa) uygulamaya değil pencereye
    // ait olmuyor, ve overlay bizi hiç ön uygulama yapmadığı için panel öndeki BAŞKA
    // uygulamanın pencerelerinin ARKASINDA açılıyordu — bir titreme, sonra hiçbir şey.
    // Ayrıca always-on-top overlay panelin üstünü kapatıyor; açılmadan önce indiriliyor.
    let overlay = window.clone();
    if let Some(w) = &overlay {
        let _ = w.set_always_on_top(false);
    }

    let mut builder = app
        .dialog()
        .file()
        .set_title("Kaydet")
        .set_file_name(&default_name)
        .add_filter("Images", &["png"]);
    if let Some(dir) = pictures {
        builder = builder.set_directory(dir);
    }
    if let Some(w) = &window {
        builder = builder.set_parent(w);
    }
    builder.save_file(move |path| {
        SAVE_DIALOG_OPEN.store(false, Ordering::Release);
        // İptal/hata yolunda overlay'i geri kaldır; kaydetme yolunda zaten kapanıyor.
        let restore_overlay = || {
            if let Some(w) = &overlay {
                let _ = w.set_always_on_top(true);
                let _ = crate::platform::set_window_level(w, crate::platform::WindowLevel::PopUpMenu);
            }
        };
        let Some(path) = path else {
            log::info!("kaydetme paneli: iptal edildi");
            restore_overlay();
            crate::windows::toast::show(&handle, "Kaydetme iptal edildi.", "info");
            return;
        };
        let Ok(p) = path.into_path() else {
            restore_overlay();
            crate::windows::toast::show(&handle, "Kaydetme Hatası: geçersiz yol", "error");
            return;
        };
        log::info!("kaydetme paneli: {} seçildi ({} bayt yazılıyor)", p.display(), png.len());
        match std::fs::write(&p, &png) {
            Ok(()) => {
                let _ = crate::gallery::add(&handle, &png);
                crate::windows::toast::show(&handle, "Resim Kaydedildi.", "success");
                crate::capture::close_all(&handle, None);
            }
            Err(e) => {
                // Electron yazma hatasında da overlay'leri kapatıyordu: hata toast'ı
                // karartmanın arkasında kalmasın, kullanıcı yeniden deneyebilsin.
                crate::windows::toast::show(&handle, &format!("Kaydetme Hatası: {e}"), "error");
                crate::capture::close_all(&handle, None);
            }
        }
    });
}

#[tauri::command]
pub async fn snip_save_image(app: tauri::AppHandle, window: tauri::WebviewWindow, data_url: String) {
    let Some(png) = decode_data_url(&data_url) else {
        crate::windows::toast::show(&app, "Kaydetme Hatası: görüntü çözülemedi", "error");
        return;
    };
    save_png(&app, Some(window), png, "snip");
}

#[tauri::command]
pub fn snip_save_buffer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
) {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        crate::windows::toast::show(&app, "Kaydetme Hatası: ham veri bekleniyordu", "error");
        return;
    };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn(async move { save_png(&app, Some(window), bytes, "scroll") });
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
            // NSPasteboard ana thread kuralı (BULGU S1-a) burada da geçerli: bu kod
            // `spawn_blocking`den dönen bir async komutun içinde, yani worker thread'de.
            let h = app.clone();
            let t = text.clone();
            let _ = app.run_on_main_thread(move || {
                crate::platform::clipboard_write_text(&t);
                crate::clipboard::history::add(&h, &t);
                crate::windows::toast::show(&h, "Metin Kopyalandı.", "success");
            });
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
pub async fn set_ignore_mouse_events(window: tauri::WebviewWindow, ignore: bool) {
    if let Err(e) = window.set_ignore_cursor_events(ignore) {
        log::warn!("tıklama geçirgenliği ayarlanamadı: {e}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod pano_gorsel_sizinti_testleri {
    //! Panoya görsel yazımı, autorelease pool'u olmayan bir thread'de birikmemeli.
    //!
    //! İki ölçüm aynı türden bir thread'de: arboard yolu (kontrol — birikmeli) ve
    //! üretim yolu `setData` (düz kalmalı). Ölçü, `heap`in saydığı CANLI ≥ 10 MB malloc
    //! blokları — ayak izi/RSS değil (bkz. `canli_buyuk_blok_sayisi`).
    //!
    //! Keşif ölçümü (test süreci içinden `heap`/`vmmap`): arboard'da 3 yazımdan sonra
    //! 3 `NSBitmapImageRep` + 3 `CGImage` + 3 piksel tamponu (Malloc Large 69,6 MB) +
    //! TIFF'ler (Foundation 45,8 MB) pano METİNLE DEĞİŞTİKTEN SONRA BİLE duruyordu;
    //! `setData`'da aynı noktada hiçbiri yoktu. Autorelease pool'una sarmak arboard
    //! yolunu kurtarmıyordu (pool'lu +61 MB / 4 yazım).
    //!
    //! Panoyu DEĞİŞTİRİR; o yüzden `#[ignore]`. Elle:
    //! `cargo test pano_gorsel -- --ignored --nocapture`
    use super::*;

    const W: u32 = 2000;
    const H: u32 = 2000;
    const N: usize = 4;

    /// Sıkıştırılamayan gürültü: TIFF de piksel tamponu kadar büyük olsun.
    fn gurultu_png() -> Vec<u8> {
        let mut x: u32 = 0x9E37_79B9;
        let raw: Vec<u8> = (0..(W * H * 4) as usize)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        let mut png = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&raw, W, H, image::ExtendedColorType::Rgba8)
            .expect("png kodlanamadı");
        png
    }

    /// Süreçteki CANLI ≥ 10 MB malloc bloklarının sayısı (`heap`): sahadaki teşhisin
    /// ölçüsü. Ayak izi / RSS kullanılmıyor — serbest bırakılan büyük bloklar libmalloc'un
    /// ertelenmiş geri alımı yüzünden saniyelerce ayak izinde kalıyor ve ölçüm
    /// zamanlamaya bağlı hâle geliyordu (setData yolunda bile sahte +15 MB/yazım).
    fn canli_buyuk_blok_sayisi() -> usize {
        let out = std::process::Command::new("heap")
            .args(["-addresses", "non-object[10000000-]", &std::process::id().to_string()])
            .output()
            .expect("heap çalışmadı");
        String::from_utf8_lossy(&out.stdout).lines().filter(|l| l.starts_with("0x")).count()
    }

    /// `std::thread` = pool'suz thread. Sayım thread BİTMEDEN alınmalı; bitince örtük
    /// pool boşalır. Pano sonda metinle temizleniyor: istemci son yazımın verisini
    /// meşru olarak tutuyor, temizlenince bırakıyor — o sızıntı değil.
    fn havuzsuz_threadde_fark(yaz: fn(&[u8]) -> Result<(), String>, png: Vec<u8>) -> isize {
        std::thread::spawn(move || {
            assert!(crate::platform::clipboard_write_text("copyboard-sızıntı-testi"));
            let once = canli_buyuk_blok_sayisi() as isize;
            for _ in 0..N {
                yaz(&png).expect("panoya yazılamadı");
            }
            assert!(crate::platform::clipboard_write_text("copyboard-sızıntı-testi"));
            canli_buyuk_blok_sayisi() as isize - once
        })
        .join()
        .expect("ölçüm thread'i düştü")
    }

    #[test]
    #[ignore = "panoyu değiştirir — elle: cargo test pano_gorsel -- --ignored --nocapture"]
    fn pano_gorsel_yazimi_havuzsuz_threadde_birikmiyor() {
        let png = gurultu_png();

        // Isınma: AppKit/CoreGraphics ilk yüklemesi ölçüme karışmasın.
        write_image_to_clipboard(&png).unwrap();

        let duzeltme = havuzsuz_threadde_fark(write_image_to_clipboard, png.clone());
        let kontrol = havuzsuz_threadde_fark(crate::platform::clipboard_write_png_arboard, png);
        eprintln!("{N} yazım, canlı ≥10 MB blok farkı: arboard {kontrol:+}, setData {duzeltme:+}");

        assert!(
            kontrol >= N as isize - 1,
            "kontrol ölçümü birikmeliydi ({kontrol:+} blok) — test artık sızıntıyı görmüyor"
        );
        assert!(duzeltme <= 0, "setData yazımı blok bırakmamalı: {duzeltme:+}");
    }
}
