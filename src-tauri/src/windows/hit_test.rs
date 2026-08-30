//! Tıklama geçirgenliği — pencere başına imleç isabet testi.
//!
//! ## Neden gerekli — BULGU F5-d
//!
//! Electron `setIgnoreMouseEvents(true, { forward: true })` sunuyordu: pencere
//! tıklama-geçirgen oluyor AMA `mousemove` olaylarını almaya DEVAM ediyordu. Hem widget
//! hem kaydedici bunun üzerine kuruluydu — geçirgen başla, iletilen hareketlerle
//! imlecin gerçek bir yüzeye geldiğini gör, geçirgenliği kaldır.
//!
//! Tauri'nin `set_ignore_cursor_events(bool)`'unda `forward` YOK ve macOS'ta
//! `ignoresMouseEvents = YES` mousemove'u da kesiyor. O modelle pencere geçirgen
//! başlıyor, bir daha hiç olay almıyor ve **kalıcı olarak tıklanamaz** kalıyor.
//!
//! Çözüm: karar renderer'dan buraya taşındı. Renderer yalnız GEOMETRİSİNİ bildiriyor,
//! imleci burası yokluyor ve geçirgenliği burası açıp kapatıyor. Kullanıcıya görünen
//! davranış birebir aynı.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

/// Bir pencerenin tıklanabilir yüzeyi. Koordinatlar CSS pikseli (renderer'ın
/// `getBoundingClientRect()` uzayı); zoom burada hesaba katılıyor.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HitArea {
    /// Yuvarlak düğme.
    Circle { cx: f64, cy: f64, r: f64 },
    /// Dikdörtgen yüzey (panel, araç çubuğu).
    Rect { x: f64, y: f64, w: f64, h: f64 },
    /// Sürükleme/basılı tutma sırasında: TÜM pencere yakalasın ki hareket kaybolmasın.
    Everything,
}

impl HitArea {
    fn contains(&self, x: f64, y: f64) -> bool {
        match *self {
            HitArea::Circle { cx, cy, r } => {
                let (dx, dy) = (x - cx, y - cy);
                dx * dx + dy * dy <= r * r
            }
            HitArea::Rect { x: rx, y: ry, w, h } => x >= rx && x <= rx + w && y >= ry && y <= ry + h,
            HitArea::Everything => true,
        }
    }
}

struct Entry {
    areas: Vec<HitArea>,
    /// İçerik zoom'u (`set_zoom`). Widget ölçek ayarıyla büyüyor.
    zoom: f64,
    /// Yüzeye YENİ girildiğinde çağrılacak mı? (Hızlı Yapıştır'ın hedef uygulamayı
    /// hatırlaması buna bağlı — bkz. `platform::note_front_app`.)
    note_front_app: bool,
}

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Entry>>);

/// Renderer geometrisini bildirdi.
pub fn set_areas(
    app: &tauri::AppHandle,
    label: &str,
    areas: Vec<HitArea>,
    zoom: f64,
    note_front_app: bool,
) {
    app.state::<Registry>().0.lock().unwrap().insert(
        label.to_string(),
        Entry { areas, zoom: if zoom > 0.0 { zoom } else { 1.0 }, note_front_app },
    );
    start_tracker(app);
}

pub fn clear(app: &tauri::AppHandle, label: &str) {
    app.state::<Registry>().0.lock().unwrap().remove(label);
}

/// Kayıtlı tüm pencereler için imleci yoklayan TEK thread.
///
/// 30 ms: fare hareketini takip edecek kadar sık, boşta ihmal edilebilir kadar seyrek.
fn start_tracker(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    std::thread::Builder::new()
        .name("copyboard-hit-test".into())
        .spawn(move || {
            let mut last: HashMap<String, bool> = HashMap::new();
            loop {
                std::thread::sleep(std::time::Duration::from_millis(30));

                let entries: Vec<(String, Vec<HitArea>, f64, bool)> = {
                    let reg = handle.state::<Registry>();
                    let map = reg.0.lock().unwrap();
                    if map.is_empty() {
                        continue;
                    }
                    map.iter()
                        .map(|(l, e)| (l.clone(), e.areas.clone(), e.zoom, e.note_front_app))
                        .collect()
                };

                let cursor = crate::geom::cursor_position(&handle);
                for (label, areas, zoom, note) in entries {
                    let Some(window) = handle.get_webview_window(&label) else {
                        last.remove(&label);
                        clear(&handle, &label);
                        continue;
                    };
                    if !window.is_visible().unwrap_or(false) {
                        continue;
                    }
                    let over = cursor
                        .and_then(|(cx, cy)| {
                            let pos = window.outer_position().ok()?;
                            let sf = window.scale_factor().ok()?;
                            // Pencereye göreli MANTIKSAL konum → CSS pikseli (zoom'a bölünür)
                            let x = (cx - pos.x as f64 / sf) / zoom;
                            let y = (cy - pos.y as f64 / sf) / zoom;
                            Some(areas.iter().any(|a| a.contains(x, y)))
                        })
                        .unwrap_or(false);

                    let ignore = !over;
                    if last.get(&label) == Some(&ignore) {
                        continue;
                    }
                    last.insert(label.clone(), ignore);

                    if let Err(e) = window.set_ignore_cursor_events(ignore) {
                        log::warn!("{label}: tıklama geçirgenliği ayarlanamadı: {e}");
                        continue;
                    }
                    log::debug!(
                        "{label}: {}",
                        if ignore { "geçirgen" } else { "tıklanabilir" }
                    );
                    // İmleç yüzeye YENİ indi: hâlâ ön uygulama DEĞİLİZ, yani bu,
                    // kullanıcının hangi uygulamada yazdığını görebileceğimiz son an.
                    if !ignore && note {
                        crate::platform::note_front_app();
                    }
                }
            }
        })
        .expect("hit-test thread'i başlatılamadı");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daire_isabet_testi() {
        let c = HitArea::Circle { cx: 34.0, cy: 34.0, r: 34.0 };
        assert!(c.contains(34.0, 34.0), "merkez içinde olmalı");
        assert!(c.contains(34.0, 1.0), "kenar içinde olmalı");
        assert!(!c.contains(0.0, 0.0), "köşe DIŞINDA olmalı — yuvarlak düğmenin anlamı bu");
        assert!(!c.contains(100.0, 34.0));
    }

    #[test]
    fn dikdortgen_isabet_testi() {
        let r = HitArea::Rect { x: 10.0, y: 20.0, w: 100.0, h: 50.0 };
        assert!(r.contains(10.0, 20.0));
        assert!(r.contains(110.0, 70.0));
        assert!(!r.contains(9.0, 20.0));
        assert!(!r.contains(111.0, 70.0));
    }

    #[test]
    fn everything_her_yeri_kapsiyor() {
        // Sürükleme sırasında hareket kaybolmamalı.
        let e = HitArea::Everything;
        assert!(e.contains(-1000.0, -1000.0));
        assert!(e.contains(0.0, 0.0));
    }

    #[test]
    fn bos_alan_listesi_hicbir_yeri_kapsamiyor() {
        let areas: Vec<HitArea> = Vec::new();
        assert!(!areas.iter().any(|a| a.contains(5.0, 5.0)));
    }
}
