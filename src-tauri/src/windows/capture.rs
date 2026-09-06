//! Yakalama overlay'i — monitör başına bir tam ekran pencere.
//!
//! Çok monitörde HER ekran karartılıyor ki kullanıcı hangisinde isterse orada seçim
//! yapabilsin (seçimin kendisi tek monitörde kalıyor).
//!
//! Tam ekran boyutu monitörün TAMAMI, çalışma alanı değil: menü çubuğu ve Dock da
//! karartmanın altında kalmalı, yoksa hem gerçek çubuk hem de yakalanan görüntüdeki
//! çubuk aynı anda görünür.

use crate::geom::MonitorInfo;
use crate::platform::WindowLevel;

/// Overlay pencere etiketlerinin ön eki — `close_all` bununla tarıyor.
pub const PREFIX: &str = "capture-";

pub fn label_for(index: usize) -> String {
    format!("{PREFIX}{index}")
}

/// Kip → hangi HTML. `color`, `snipper`'ı saf bir renk seçici olarak yeniden kullanıyor
/// (karartma yok, seçim yok, araç çubuğu yok — tıkla ve o pikselin hex'i panoya gitsin).
fn url_for(mode: &str) -> &'static str {
    match mode {
        "ocr" => "ocr/ocr.html",
        "video" => "recorder/recorder.html",
        "scroll" => "scroller/scroller.html",
        _ => "snipper/snipper.html",
    }
}

pub fn create(
    app: &tauri::AppHandle,
    mode: &str,
    index: usize,
    monitor: &MonitorInfo,
) -> Result<tauri::WebviewWindow, String> {
    let label = label_for(index);

    // ── BAYAT İSABET ALANI KAYDINI SİL ───────────────────────────────────────
    //
    // İsabet alanları PENCERE ETİKETİNE göre kaydediliyor ve overlay'ler hep aynı
    // etiketi kullanıyor (`capture-0`, `capture-1`). Kaydedici durdurulunca bilerek
    // `setHitAreas([])` bildiriyor — "her yeri geçirgen yap", kullanıcı alttaki
    // uygulamayla çalışabilsin diye. O kayıt oturum kapanınca ORTADA KALIYOR.
    //
    // Sonuç: bir sonraki ekran görüntüsü ya da OCR overlay'i aynı etiketle açılıyor,
    // `snipper.js` ve `ocr.js` isabet alanı HİÇ bildirmediği için bayat kayıt
    // yürürlükte kalıyor ve yoklayıcı pencereyi tıklama geçirgen yapıyor. Kullanıcı
    // karartmayı ve çerçeveyi görüyor ama fare hiçbir şey yapmıyor; tıklama da
    // hareket de altındaki uygulamaya geçiyor. Kullanıcının bildirdiği "bir kere
    // tıklamadan alan seçemiyorum" ve "büyüteç fareyi takip etmiyor" bu.
    //
    // Yoklayıcı pencere yok olduğunda kaydı kendisi siliyor, ama imleç kıpırdamazsa
    // tam denetimi 300 ms'ye kadar atlıyor — kapanış ile yeni oturum arası o
    // pencereye sığdığında kayıt yeni pencereye miras kalıyor. Yarış buradan.
    // Yeni overlay kurulurken silmek yarışı tamamen kapatıyor.
    crate::windows::hit_test::clear(app, &label);
    // Etiketler `&'static str` isteyen bir alanda tutuluyor; overlay sayısı monitör
    // sayısıyla sınırlı ve oturum boyunca yeniden kullanılıyor.
    let leaked: &'static str = Box::leak(label.clone().into_boxed_str());

    let window = super::build(
        app,
        super::WindowSpec {
            label: leaked,
            url: url_for(mode),
            width: monitor.width,
            height: monitor.height,
            transparent: true,
            decorations: false,
            resizable: false,
            shadow: false,
            skip_taskbar: true,
            focusable: true,
            always_on_top: true,
            level: Some(WindowLevel::PopUpMenu),
            all_spaces: true,
            // Video kaydı ve kaydırmalı yakalama CANLI masaüstünü okuyor; bu overlay'in
            // seçim çerçevesi, araç çubuğu ve HUD'ı aksi hâlde sonuca film olurdu.
            // Kullanıcıya görünür kalırken her türlü ekran yakalamadan dışlanıyor.
            // Kurulumda veriliyor, yakalama başlarken değil — arada bir karenin
            // overlay'i yakalayabileceği bir pencere kalmasın.
            content_protected: matches!(mode, "video" | "scroll"),
            background: Some((0, 0, 0, 0)),
            visible: false,
            ..Default::default()
        },
    )?;

    // Monitörün TAM alanına yerleştir (çalışma alanı değil) — hedef monitörün KENDİ
    // ölçeğiyle, fiziksel piksel cinsinden (karışık DPI, bkz. geom::physical_rect).
    if let Err(e) = crate::geom::place_on_monitor(&window, monitor) {
        log::warn!("{leaked}: overlay konumlandırılamadı: {e}");
    }
    crate::capture::remember_overlay(app, &label, monitor);
    Ok(window)
}
