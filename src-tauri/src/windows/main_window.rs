//! Ana pencere — pano geçmişi, favoriler, galeri ve ayarlar.
//!
//! Davranışı Electron sürümünden birebir taşınıyor, üç incelik dahil:
//!
//! 1. **Tıklama-dışarı kapanması yalnız odağı GERÇEKTEN ALMIŞ pencere için.** Tepsi
//!    tıklamasından sonra başka bir uygulama odağı geri kaparsa pencere hiç aktif
//!    olmamış demektir; oradaki bir blur'da gizlenmek "Göster"i ölü göstermişti.
//! 2. **Gösterimden hemen sonraki blur yok sayılır** (`SHOW_SETTLE_MS`) — macOS odağı
//!    devrederken mikrosaniyeler içinde blur gelebiliyor.
//! 3. **Tepsi tıklaması aç/kapa**: pencere blur'da kendini gizlediği için tıklama olayı
//!    geldiğinde çoktan gizlenmiş oluyor; az önce olmuş bir gizleme "bu tıklama kapattı"
//!    sayılır (`TOGGLE_GUARD_MS`), yoksa tepsi simgesi kapatma düğmesi olarak kullanılamaz.

use std::time::Instant;

use tauri::{Manager, WindowEvent};

use crate::geom;
use crate::platform::{self, WindowLevel};
use crate::state::{AppState, SHOW_SETTLE_MS, TOGGLE_GUARD_MS};

pub const LABEL: &str = "main";

const WIDTH: f64 = 350.0;
const HEIGHT: f64 = 550.0;
/// Electron'daki `width - 380` / `height - 560`: pencerenin 350x550 boyutuna
/// sağdan 30, alttan 10 piksel pay.
const MARGIN_RIGHT: f64 = 380.0;
const MARGIN_BOTTOM: f64 = 560.0;

pub fn create(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let window = super::build(
        app,
        super::WindowSpec {
            label: LABEL,
            url: "main-window/index.html",
            width: WIDTH,
            height: HEIGHT,
            // macOS'ta şeffaf + vibrancy; Windows'ta düz arka plan (Electron de öyleydi).
            transparent: cfg!(target_os = "macos"),
            decorations: false,
            resizable: false,
            skip_taskbar: true,
            always_on_top: true,
            level: Some(WindowLevel::ScreenSaver),
            // macOS Spaces: bu olmadan pencere en son gösterildiği Space'e ait olur ve
            // global kısayol kullanıcıyı o masaüstüne SÜRÜKLER. Tüm masaüstlerine
            // katılınca kullanıcının bulunduğu yerde açılır.
            all_spaces: true,
            background: Some((0x2c, 0x2c, 0x2e, 0xff)),
            visible: false,
            ..Default::default()
        },
    )?;

    #[cfg(target_os = "macos")]
    if let Err(e) = platform::macos::apply_vibrancy(&window) {
        log::warn!("ana pencere vibrancy uygulanamadı: {e}");
    }

    wire_focus_events(app, &window);
    Ok(window)
}

fn wire_focus_events(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let handle = app.clone();
    window.on_window_event(move |event| {
        let WindowEvent::Focused(focused) = event else { return };
        let state = handle.state::<AppState>();
        let mut rt = state.runtime.lock().unwrap();

        if *focused {
            rt.main_was_focused = true;
            return;
        }

        // ── blur ──
        if rt
            .main_shown_at
            .map(|t| t.elapsed().as_millis() < SHOW_SETTLE_MS)
            .unwrap_or(false)
        {
            return; // odak hâlâ yerine oturuyor
        }
        if !rt.main_was_focused {
            return; // pencere hiç aktif olmadı — bu blur bir kapanma sebebi değil
        }
        rt.main_hidden_at = Some(Instant::now());
        drop(rt);

        if let Some(w) = handle.get_webview_window(LABEL) {
            super::emit_to(&handle, LABEL, "reset-view", ());
            let _ = w.hide();
        }
    });
}

/// Pencereyi imlecin bulunduğu monitörün sağ alt köşesinde gösterir.
pub fn show(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        log::warn!("ana pencere yok — show() atlandı");
        return;
    };

    if let Some(m) = geom::monitor_at_cursor(app).or_else(|| geom::primary_monitor(app)) {
        let x = m.work_x + m.work_width - MARGIN_RIGHT;
        let y = m.work_y + m.work_height - MARGIN_BOTTOM;
        if let Err(e) = geom::place(&window, x, y, WIDTH, HEIGHT) {
            log::warn!("ana pencere konumlandırılamadı: {e}");
        }
    }

    let _ = platform::set_window_level(&window, WindowLevel::ScreenSaver);

    {
        let state = app.state::<AppState>();
        let mut rt = state.runtime.lock().unwrap();
        rt.main_shown_at = Some(Instant::now());
        rt.main_was_focused = false;
    }

    let _ = window.show();
    // Dock gizli (accessory app) olduğu için show()+focus() tek başına CopyBoard'u
    // aktif uygulama yapmaya yetmiyor ve taze pencere odağı hemen kaybedebiliyor.
    platform::activate_app();
    let _ = window.set_focus();

    // Geçmiş yayınları gizli pencereleri atlıyor, yani liste pencere gizlenmeden
    // önceki hâlde kalmış olabilir — görünür olduğu bu anda tazele.
    crate::clipboard::history::push_snapshot(app, LABEL);
}

/// Tepsi tıklaması: açıksa kapat, kapalıysa aç.
pub fn toggle(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        {
            let state = app.state::<AppState>();
            state.runtime.lock().unwrap().main_hidden_at = Some(Instant::now());
        }
        let _ = window.hide();
        return;
    }

    // Blur bu tıklamayla pencereyi az önce gizlediyse, tıklama bir KAPATMAYDI.
    let just_hidden = {
        let state = app.state::<AppState>();
        let rt = state.runtime.lock().unwrap();
        rt.main_hidden_at
            .map(|t| t.elapsed().as_millis() < TOGGLE_GUARD_MS)
            .unwrap_or(false)
    };
    if just_hidden {
        return;
    }
    show(app);
}

pub fn hide(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}
