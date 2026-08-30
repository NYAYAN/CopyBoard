//! Güncelleme diyaloğu penceresi.

use crate::geom;

pub const LABEL: &str = "update";

const W: f64 = 380.0;
const H: f64 = 500.0;

pub fn ensure(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = tauri::Manager::get_webview_window(app, LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }
    let window = super::build(
        app,
        super::WindowSpec {
            label: LABEL,
            url: "update/update-dialog.html",
            width: W,
            height: H,
            transparent: true,
            decorations: false,
            resizable: false,
            always_on_top: true,
            // Uygulamanın diğer pencerelerinin aksine bu görev çubuğunda görünür:
            // kullanıcı bir indirmeyi arka plana alıp geri dönebilmeli.
            skip_taskbar: false,
            background: Some((0, 0, 0, 0)),
            visible: false,
            ..Default::default()
        },
    )?;

    if let Some(m) = geom::primary_monitor(app) {
        let x = m.work_x + (m.work_width - W) / 2.0;
        let y = m.work_y + (m.work_height - H) / 2.0;
        let _ = window.show();
        let _ = geom::place(&window, x, y, W, H);
    } else {
        let _ = window.show();
    }
    let _ = window.set_focus();
    Ok(window)
}
