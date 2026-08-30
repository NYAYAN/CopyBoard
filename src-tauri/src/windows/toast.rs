//! Bildirim balonu.
//!
//! Pencere BİR KEZ kurulur ve yeniden kullanılır: Electron sürümünde her toast eski
//! pencereyi yok edip yenisini yaratıyordu — bildirim başına bir renderer süreci
//! (~100-300 ms CPU). Burada bittiğinde gizleniyor, yeni mesajda yeniden konumlanıp
//! gösteriliyor.
//!
//! Geri bildirim, kullanıcının çalıştığı monitörde (imleç) görünür — her toast'ta
//! yeniden hesaplanır, çünkü imleç monitörler arasında gezer.

use tauri::Manager;

use crate::geom;
use crate::platform::WindowLevel;
use crate::state::AppState;

pub const LABEL: &str = "toast";

const WIDTH: f64 = 320.0;
const HEIGHT: f64 = 100.0;
/// Sağ kenardan 370 (320 genişlik + 50 pay), üstten 50.
const MARGIN_RIGHT: f64 = 370.0;
const MARGIN_TOP: f64 = 50.0;

pub const MIN_HEIGHT: f64 = 60.0;
pub const MAX_HEIGHT: f64 = 400.0;

/// Toast'u gösterir. Pencere henüz yüklenmediyse mesaj beklemeye alınır ve
/// `toast_ready()` çağrıldığında teslim edilir (en son mesaj kazanır).
pub fn show(app: &tauri::AppHandle, message: &str, kind: &str) {
    let state = app.state::<AppState>();

    if app.get_webview_window(LABEL).is_some() {
        let ready = state.runtime.lock().unwrap().toast_ready;
        if ready {
            present(app, message, kind);
        } else {
            state.runtime.lock().unwrap().pending_toast =
                Some((message.to_string(), kind.to_string()));
        }
        return;
    }

    {
        let mut rt = state.runtime.lock().unwrap();
        rt.toast_ready = false;
        rt.pending_toast = Some((message.to_string(), kind.to_string()));
    }

    match super::build(
        app,
        super::WindowSpec {
            label: LABEL,
            url: "toast/toast.html",
            width: WIDTH,
            height: HEIGHT,
            transparent: true,
            decorations: false,
            resizable: false,
            shadow: false,
            skip_taskbar: true,
            // Odak ALMAZ: toast hiçbir zaman kullanıcının yazdığı yerden odağı çalmamalı.
            focusable: false,
            always_on_top: true,
            level: Some(WindowLevel::ScreenSaver),
            all_spaces: true,
            background: Some((0, 0, 0, 0)),
            visible: false,
            ..Default::default()
        },
    ) {
        Ok(window) => {
            // Tıklama geçirgen: altındaki uygulamayı engellemez.
            if let Err(e) = window.set_ignore_cursor_events(true) {
                log::warn!("toast tıklama geçirgenliği ayarlanamadı: {e}");
            }
        }
        Err(e) => log::error!("toast penceresi kurulamadı: {e}"),
    }
}

/// Renderer sayfası yüklendiğini bildirdi — bekleyen mesajı teslim et.
pub fn ready(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let pending = {
        let mut rt = state.runtime.lock().unwrap();
        rt.toast_ready = true;
        rt.pending_toast.take()
    };
    if let Some((message, kind)) = pending {
        present(app, &message, &kind);
    }
}

fn present(app: &tauri::AppHandle, message: &str, kind: &str) {
    let Some(window) = app.get_webview_window(LABEL) else { return };

    // ── SIRA ÖNEMLİ ─────────────────────────────────────────────────────────
    // Konum, pencere GÖRÜNÜR olduktan SONRA verilmeli. Gizli bir pencereye
    // set_position uygulamak macOS'ta işe yaramıyor: show() kendi yerleşimini
    // uyguluyor ve verdiğimiz koordinat sessizce kayboluyor.
    //
    // > Ölçüldü: (2248, -1360) istendi, show() sonrası pencere (738, -1082)'deydi.
    //
    // Bu yüzden: önce göster, sonra yerleştir. Pencere şeffaf ve içeriği
    // (kart) `show` sınıfı eklenene dek ekran dışında park ettiği için,
    // bu sıradaki bir kare titremesi kullanıcıya görünmüyor.
    // show() — set_focus() DEĞİL: pencere focusable:false, odak yerinde kalır.
    if let Err(e) = window.show() {
        log::error!("toast gösterilemedi: {e}");
    }
    position(app);
    super::emit_to(app, LABEL, "display-toast", (message, kind));
}

fn position(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let Some(m) = geom::monitor_at_cursor(app).or_else(|| geom::primary_monitor(app)) else {
        return;
    };
    // Yükseklik, renderer'ın `toast_resize` ile bildirdiği değer olabilir; onu da
    // hedef monitörün ölçeğiyle mantıksala çeviriyoruz (pencerenin o anki ekranı
    // farklı DPI'da olabilir — bkz. geom::place).
    let h = window
        .inner_size()
        .ok()
        .and_then(|sz| window.scale_factor().ok().map(|s| sz.height as f64 / s))
        .unwrap_or(HEIGHT);
    let x = m.work_x + m.work_width - MARGIN_RIGHT;
    let y = m.work_y + MARGIN_TOP;
    if let Err(e) = geom::place(&window, x, y, WIDTH, h.max(MIN_HEIGHT)) {
        log::error!("toast konumlandırılamadı: {e}");
    }
}

/// Mesaj bittiğinde gizle — YOK ETME (pencere yeniden kullanılıyor).
pub fn finished(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}

/// Renderer, yerleşimi ölçüp kendisine sığan yüksekliği istiyor: pencere sabit
/// boyutlu bir OS dikdörtgeni olduğu için uzun bir mesaj KIRPILIYORDU. Sol üst
/// köşe sabit kalacak şekilde aşağı doğru büyür.
pub fn resize(app: &tauri::AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let h = height.round().clamp(MIN_HEIGHT, MAX_HEIGHT);
    // Toast hangi monitördeyse ONUN ölçeği geçerli.
    let scale = window.scale_factor().unwrap_or(1.0);
    let current = window.inner_size().ok().map(|s| s.height as f64 / scale).unwrap_or(0.0);
    if (current - h).abs() < 1.0 {
        return;
    }
    let _ = window.set_size(tauri::LogicalSize::new(WIDTH, h));
}
