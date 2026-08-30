//! Büyük görüntüleyici — ekran görüntüsüne göre boyutlanan, çerçevesiz ama
//! yeniden boyutlandırılabilir bir pencere.
//!
//! Ana penceredeki önizleme 350 px'e sıkışıyor; tam çözünürlüklü bir yakalamayı
//! gerçekten incelemenin yolu bu değil.

use crate::geom::{self, MonitorInfo};

pub const LABEL: &str = "viewer";

/// Araç çubuğu satırı + alttaki küçük resim şeridi.
const CHROME_H: f64 = 44.0 + 64.0;
/// `viewer.css`'teki `.stage` dolgusu — en küçük boşluk.
const STAGE_PAD: f64 = 10.0;
/// Yer varken görüntünün sahnenin ne kadarını kaplayacağı.
const FILL: f64 = 0.8;

const MIN_W: f64 = 480.0;
const MIN_H: f64 = 320.0;

/// Görüntü boyutuna göre pencere ölçüsü ve konumu.
///
/// Önce 1:1 gelir — %94'te çizilen bir ekran görüntüsü BULANIK bir ekran görüntüsüdür —
/// yani görüntü ölçeği yalnızca "sığdığı kadar büyük, asla büyütülmemiş" oluyor.
/// Sonra sahne resimden DAHA BÜYÜK açılıyor ki resim çerçeveye yapışık değil biraz
/// boşluk içinde dursun: ya sahnenin `FILL` kadarını kaplayacak kadar, ya da ekranın
/// bıraktığı kadar — hangisi küçükse. Ekrana sığmayan bir görüntüde o boşluk olamaz,
/// 10 px'lik dolgu kalır.
pub fn bounds_for(image_w: f64, image_h: f64, m: &MonitorInfo) -> (f64, f64, f64, f64) {
    let pad_h = STAGE_PAD * 2.0;
    let room_w = m.work_width * 0.85 - pad_h;
    let room_h = m.work_height * 0.85 - CHROME_H - pad_h;

    let scale = (room_w / image_w).min(room_h / image_h).min(1.0);
    let stage_w = (image_w * scale / FILL).round().min(room_w.floor());
    let stage_h = (image_h * scale / FILL).round().min(room_h.floor());

    let width = (stage_w + pad_h).max(MIN_W);
    let height = (stage_h + CHROME_H + pad_h).max(MIN_H);
    let x = m.work_x + (m.work_width - width) / 2.0;
    let y = m.work_y + (m.work_height - height) / 2.0;
    (x.round(), y.round(), width, height)
}

pub fn ensure(app: &tauri::AppHandle, image_w: f64, image_h: f64) -> Result<tauri::WebviewWindow, String> {
    let m = geom::monitor_at_cursor(app)
        .or_else(|| geom::primary_monitor(app))
        .ok_or("monitör bulunamadı")?;
    let (x, y, w, h) = bounds_for(image_w.max(1.0), image_h.max(1.0), &m);

    if let Some(existing) = tauri::Manager::get_webview_window(app, LABEL) {
        let _ = existing.show();
        let _ = geom::place(&existing, x, y, w, h);
        let _ = existing.set_focus();
        return Ok(existing);
    }

    let window = super::build(
        app,
        super::WindowSpec {
            label: LABEL,
            url: "viewer/viewer.html",
            width: w,
            height: h,
            decorations: false,
            resizable: true,
            shadow: true,
            // Uygulamanın diğer TÜM pencereleri skipTaskbar; görev çubuğu düğmesi
            // görülen tek pencere bu.
            skip_taskbar: false,
            background: Some((0x1c, 0x1c, 0x1e, 0xff)),
            visible: false,
            ..Default::default()
        },
    )?;
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(MIN_W, MIN_H)));
    let _ = geom::place(&window, x, y, w, h);
    Ok(window)
}

/// Maksimize edilen ÇERÇEVESİZ bir pencere, yeniden boyutlandırma kenarını taşma
/// olarak alıyor: Windows'ta pencere dikdörtgeni çalışma alanının her yanından dışarı
/// çıkıyor (ölçüldü: %100 ölçekte -8,-8 +16x16), yani araç çubuğunun üst satırı,
/// kapat düğmesinin sağ kenarı ve şeridin alt satırı ekran dışında kalıyor — sonuncusu
/// görev çubuğunun ARKASINDA. Dikdörtgen bizim düzeltebileceğimiz bir şey değil:
/// Chromium o pencere stilini gölge ve yapıştırma hareketleri için tutuyor ve pencere
/// maksimizeyken `setBounds` yok sayılıyor. Onun yerine İÇERİK, taşma neyse o kadar
/// içeri alınıyor — asla sabit bir 8 değil, çünkü o DPI ile değişiyor.
pub fn window_state(window: &tauri::WebviewWindow, app: &tauri::AppHandle) -> serde_json::Value {
    let maximized = window.is_maximized().unwrap_or(false);
    if !maximized {
        return serde_json::json!({
            "maximized": false,
            "inset": { "top": 0, "right": 0, "bottom": 0, "left": 0 }
        });
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let pos = window.outer_position().ok();
    let size = window.outer_size().ok();
    let (Some(pos), Some(size)) = (pos, size) else {
        return serde_json::json!({ "maximized": true, "inset": { "top": 0, "right": 0, "bottom": 0, "left": 0 } });
    };
    let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);

    let m = geom::monitor_matching(app, x, y, w, h);
    let inset = match m {
        Some(m) => serde_json::json!({
            "top": (m.work_y - y).max(0.0).round(),
            "right": ((x + w) - (m.work_x + m.work_width)).max(0.0).round(),
            "bottom": ((y + h) - (m.work_y + m.work_height)).max(0.0).round(),
            "left": (m.work_x - x).max(0.0).round(),
        }),
        None => serde_json::json!({ "top": 0, "right": 0, "bottom": 0, "left": 0 }),
    };
    serde_json::json!({ "maximized": true, "inset": inset })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon() -> MonitorInfo {
        MonitorInfo {
            x: 0.0, y: 0.0, width: 1800.0, height: 1169.0,
            work_x: 0.0, work_y: 39.0, work_width: 1800.0, work_height: 1074.0,
            scale: 2.0,
            name: None,
        }
    }

    #[test]
    fn kucuk_goruntu_etrafinda_bosluk_birakiyor() {
        // Sahne resimden BÜYÜK açılmalı — resim çerçeveye yapışmasın.
        let m = mon();
        let (_, _, w, h) = bounds_for(400.0, 300.0, &m);
        assert!(w > 400.0 + STAGE_PAD * 2.0, "genişlikte boşluk yok: {w}");
        assert!(h > 300.0 + CHROME_H, "yükseklikte boşluk yok: {h}");
    }

    #[test]
    fn ekrandan_buyuk_goruntu_calisma_alanini_asmiyor() {
        let m = mon();
        let (x, y, w, h) = bounds_for(6000.0, 4000.0, &m);
        assert!(w <= m.work_width, "pencere çalışma alanından geniş: {w}");
        assert!(h <= m.work_height, "pencere çalışma alanından yüksek: {h}");
        assert!(x >= m.work_x - 1.0 && y >= m.work_y - 1.0);
    }

    #[test]
    fn cok_uzun_kaydirma_yakalamasi_da_sigiyor() {
        // 766x8175 — galeri küçük resmini bozan aynı uç oran
        let m = mon();
        let (_, _, w, h) = bounds_for(766.0, 8175.0, &m);
        assert!(h <= m.work_height && w <= m.work_width);
        assert!(w >= MIN_W && h >= MIN_H);
    }

    #[test]
    fn minik_goruntu_asgari_boyutun_altina_dusmuyor() {
        let m = mon();
        let (_, _, w, h) = bounds_for(20.0, 10.0, &m);
        assert!(w >= MIN_W && h >= MIN_H);
    }
}
