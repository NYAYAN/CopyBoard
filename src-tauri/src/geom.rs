//! Monitör geometrisi — mantıksal (DIP) ve fiziksel piksel arasındaki TEK sınır.
//!
//! ## Neden ayrı bir modül
//!
//! Electron'un `screen` API'si her şeyi **mantıksal** piksel verir; `setBounds`/`getBounds`
//! de mantıksaldır. Tauri karışıktır ve Spike-1'de ölçüldü (BULGU S1-b):
//!
//! | API | Birim |
//! |---|---|
//! | `WebviewWindowBuilder::inner_size` / `position` | **mantıksal** |
//! | `Monitor::size()` / `position()` / `work_area()` | **fiziksel** |
//! | `Window::outer_position()` / `outer_size()` | **fiziksel** |
//! | `Window::set_position(LogicalPosition)` | tipin kendisi seçer |
//!
//! İkisini karıştırmak 2x ekranda widget'ı ekran dışına atan, toast'u yanlış monitörde
//! açan sınıf hatalar üretir. **Kural: monitör verisi okunur okunmaz mantıksala çevrilir;
//! fiziksele yalnız ekran YAKALAMA çağrılarında dönülür** (orada gerçekten piksel lazım).

use tauri::{LogicalPosition, LogicalSize, Monitor, PhysicalPosition};

/// Bir monitörün mantıksal koordinatlardaki hâli.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MonitorInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Menü çubuğu / görev çubuğu düşülmüş kullanılabilir alan.
    pub work_x: f64,
    pub work_y: f64,
    pub work_width: f64,
    pub work_height: f64,
    pub scale: f64,
}

impl MonitorInfo {
    pub fn from(m: &Monitor) -> Self {
        let s = m.scale_factor();
        let size = m.size().to_logical::<f64>(s);
        let pos = m.position().to_logical::<f64>(s);
        let wa = m.work_area();
        let wpos = wa.position.to_logical::<f64>(s);
        let wsize = wa.size.to_logical::<f64>(s);
        Self {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            work_x: wpos.x,
            work_y: wpos.y,
            work_width: wsize.width,
            work_height: wsize.height,
            scale: s,
        }
    }

    /// Ekran yakalama için: bu monitörün FİZİKSEL piksel boyutu.
    pub fn physical_size(&self) -> (u32, u32) {
        (
            (self.width * self.scale).round() as u32,
            (self.height * self.scale).round() as u32,
        )
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }

    /// Bir dikdörtgenin bu monitörle kesişim alanı — "hangi monitördeyim" kararı için.
    fn overlap(&self, x: f64, y: f64, w: f64, h: f64) -> f64 {
        let ox = (self.x + self.width).min(x + w) - self.x.max(x);
        let oy = (self.y + self.height).min(y + h) - self.y.max(y);
        if ox <= 0.0 || oy <= 0.0 {
            0.0
        } else {
            ox * oy
        }
    }
}

pub fn all_monitors(app: &tauri::AppHandle) -> Vec<MonitorInfo> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(MonitorInfo::from)
        .collect()
}

pub fn primary_monitor(app: &tauri::AppHandle) -> Option<MonitorInfo> {
    app.primary_monitor()
        .ok()
        .flatten()
        .as_ref()
        .map(MonitorInfo::from)
        .or_else(|| all_monitors(app).into_iter().next())
}

/// İmlecin MANTIKSAL konumu. Tauri fiziksel verir.
pub fn cursor_position(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let p: PhysicalPosition<f64> = app.cursor_position().ok()?;
    // Ölçek, imlecin ÜZERİNDE olduğu monitörünki olmalı; monitörleri fiziksel
    // koordinatta tarayıp bulunanın ölçeğiyle çeviriyoruz.
    for m in app.available_monitors().unwrap_or_default() {
        let s = m.scale_factor();
        let mp = m.position();
        let ms = m.size();
        if p.x >= mp.x as f64
            && p.x < (mp.x + ms.width as i32) as f64
            && p.y >= mp.y as f64
            && p.y < (mp.y + ms.height as i32) as f64
        {
            return Some((p.x / s, p.y / s));
        }
    }
    let s = primary_monitor(app).map(|m| m.scale).unwrap_or(1.0);
    Some((p.x / s, p.y / s))
}

/// Electron `screen.getDisplayNearestPoint()` — nokta mantıksal koordinatta.
pub fn monitor_nearest_point(app: &tauri::AppHandle, x: f64, y: f64) -> Option<MonitorInfo> {
    let monitors = all_monitors(app);
    if monitors.is_empty() {
        return None;
    }
    if let Some(m) = monitors.iter().find(|m| m.contains(x, y)) {
        return Some(*m);
    }
    // Hiçbirinin içinde değil (monitörler arası boşluk / ekran dışı): en yakını.
    monitors
        .into_iter()
        .min_by(|a, b| {
            let da = dist_to_rect(x, y, a);
            let db = dist_to_rect(x, y, b);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
}

/// İmlecin bulunduğu monitör — toast ve hızlı yapıştır bunun üzerinde açılır.
pub fn monitor_at_cursor(app: &tauri::AppHandle) -> Option<MonitorInfo> {
    let (x, y) = cursor_position(app)?;
    monitor_nearest_point(app, x, y)
}

/// Electron `screen.getDisplayMatching(bounds)` — en çok kesişen monitör.
pub fn monitor_matching(app: &tauri::AppHandle, x: f64, y: f64, w: f64, h: f64) -> Option<MonitorInfo> {
    all_monitors(app)
        .into_iter()
        .max_by(|a, b| {
            a.overlap(x, y, w, h)
                .partial_cmp(&b.overlap(x, y, w, h))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn dist_to_rect(x: f64, y: f64, m: &MonitorInfo) -> f64 {
    let dx = (m.x - x).max(0.0).max(x - (m.x + m.width));
    let dy = (m.y - y).max(0.0).max(y - (m.y + m.height));
    dx * dx + dy * dy
}

/// Pencereyi mantıksal (nokta) koordinatlara yerleştirir.
///
/// ## ⚠ İki tuzak, ikisi de ölçülerek bulundu
///
/// **1. Konum, pencere GÖRÜNÜR olduktan SONRA verilmeli.** Gizli bir pencereye
/// `set_position` uygulamak macOS'ta sessizce kayboluyor: `show()` kendi varsayılan
/// yerleşimini uyguluyor ve verilen koordinat yok sayılıyor.
///
/// > Ölçüldü: (2248, -1360) istendi; gizliyken verilince pencere macOS'un
/// > cascade konumunda (740, 283) açıldı, hiçbir hata dönmeden.
///
/// **2. Tip `Logical` olmalı, `Physical` DEĞİL.** macOS'un global pencere koordinat
/// uzayı NOKTA cinsindendir ve monitörler arasında tek biçimlidir — 2x bir ekranın
/// yanındaki 1x ekran aynı nokta ızgarasında yaşar. tao ise `Position`'ı platforma
/// vermeden önce **pencerenin O ANKİ ölçeğiyle** mantıksala çevirir. Bu yüzden
/// `PhysicalPosition` vermek, 2x ekranda doğmuş bir pencere için değeri İKİYE BÖLER.
///
/// > Ölçüldü: `PhysicalPosition(2248, -1360)` → pencere (1124, -680)'de.
/// > Tam olarak yarısı.
///
/// [`MonitorInfo`] zaten her şeyi noktaya çevirdiği için buraya gelen değerler
/// doğrudan kullanılabilir.
///
/// > Windows notu: orada global uzay fiziksel pikseldir ve tao dönüşümü pencerenin
/// > DPI'ıyla yapar. Karışık DPI'lı Windows kurulumları Faz 6'da ayrıca ölçülecek.
pub fn place(window: &tauri::WebviewWindow, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let size = LogicalSize::new(w, h);
    let pos = LogicalPosition::new(x, y);
    window
        .set_size(size)
        .map_err(|e| format!("set_size({size:?}): {e}"))?;
    window
        .set_position(pos)
        .map_err(|e| format!("set_position({pos:?}): {e}"))
}

/// Bir dikdörtgeni monitörün kullanılabilir alanına sıkıştırır (Electron'daki
/// `ensureWidgetInBounds` ve quick-paste konumlandırmasının ortak parçası).
pub fn clamp_to_work_area(m: &MonitorInfo, x: f64, y: f64, w: f64, h: f64, margin: f64) -> (f64, f64) {
    let max_x = m.work_x + m.work_width - w - margin;
    let max_y = m.work_y + m.work_height - h - margin;
    (
        x.clamp(m.work_x + margin, max_x.max(m.work_x + margin)),
        y.clamp(m.work_y + margin, max_y.max(m.work_y + margin)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: f64, y: f64, w: f64, h: f64, scale: f64) -> MonitorInfo {
        MonitorInfo {
            x, y, width: w, height: h,
            work_x: x, work_y: y + 25.0, work_width: w, work_height: h - 25.0,
            scale,
        }
    }

    #[test]
    fn fiziksel_boyut_olcekle_carpilir() {
        // Spike-1'de ölçülen gerçek monitör: 1800x1169 mantıksal @2x → 3600x2338 fiziksel
        assert_eq!(mon(0.0, 0.0, 1800.0, 1169.0, 2.0).physical_size(), (3600, 2338));
        assert_eq!(mon(0.0, 0.0, 3440.0, 1440.0, 1.0).physical_size(), (3440, 1440));
    }

    #[test]
    fn nokta_iceren_monitor_bulunur() {
        let a = mon(0.0, 0.0, 1800.0, 1169.0, 2.0);
        let b = mon(-822.0, -1440.0, 3440.0, 1440.0, 1.0);
        assert!(a.contains(100.0, 100.0));
        assert!(!a.contains(-100.0, -100.0));
        assert!(b.contains(-100.0, -100.0));
    }

    #[test]
    fn kesisim_alani_en_cok_ortulen_monitoru_secer() {
        let a = mon(0.0, 0.0, 1000.0, 1000.0, 1.0);
        let b = mon(1000.0, 0.0, 1000.0, 1000.0, 1.0);
        // Pencere ağırlıklı olarak b'de
        assert!(b.overlap(900.0, 0.0, 400.0, 100.0) > a.overlap(900.0, 0.0, 400.0, 100.0));
    }

    #[test]
    fn calisma_alanina_sikistirma() {
        let m = mon(0.0, 0.0, 1000.0, 800.0, 1.0); // work: y=25, h=775
        // Sağ alta taşan pencere içeri çekilir
        let (x, y) = clamp_to_work_area(&m, 990.0, 790.0, 300.0, 380.0, 8.0);
        assert_eq!(x, 1000.0 - 300.0 - 8.0);
        assert_eq!(y, 25.0 + 775.0 - 380.0 - 8.0);
        // Sol üste taşan pencere de
        let (x, y) = clamp_to_work_area(&m, -50.0, -50.0, 300.0, 380.0, 8.0);
        assert_eq!(x, 8.0);
        assert_eq!(y, 33.0);
    }

    #[test]
    fn monitor_bilgisi_nokta_uzayinda_tek_bicimli() {
        // macOS'un global pencere uzayı NOKTA cinsinden ve monitörler arası tek
        // biçimli. MonitorInfo bunu koruyor: 2x ekran 1800x1169 nokta, yanındaki
        // 1x ekran 3440x1440 nokta — ikisi de aynı ızgarada.
        let builtin = mon(0.0, 0.0, 1800.0, 1169.0, 2.0);
        let external = mon(-822.0, -1440.0, 3440.0, 1440.0, 1.0);
        // Harici ekranın sağ alt köşesi, dahilinin sol üstünün solunda/üstünde
        assert!(external.x < builtin.x);
        assert!(external.y < builtin.y);
        // Fiziksel boyut yalnız YAKALAMA için; yerleşim hesabına karışmaz.
        assert_eq!(builtin.physical_size(), (3600, 2338));
        assert_eq!(external.physical_size(), (3440, 1440));
    }

    #[test]
    fn ekrandan_buyuk_pencere_sol_uste_yaslanir() {
        // Sıkıştırma aralığı ters dönerse clamp panik atardı — bu testin varlık sebebi
        let m = mon(0.0, 0.0, 400.0, 300.0, 1.0);
        let (x, y) = clamp_to_work_area(&m, 0.0, 0.0, 900.0, 900.0, 8.0);
        assert_eq!((x, y), (8.0, 33.0));
    }
}
