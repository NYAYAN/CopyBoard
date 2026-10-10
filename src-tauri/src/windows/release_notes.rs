//! "Tüm sürüm notları" penceresi — güncelleme diyaloğundaki bağlantı açıyor.
//!
//! Veri ayrı bir istekle gelmiyor: güncelleme kontrolünün zaten indirdiği
//! `latest.json`'ın `changelog` alanı (bkz. scripts/release-files.mjs), diyaloğa giden
//! bilgiyle birlikte saklanıyor ve pencere hazır olunca aynı el sıkışmasıyla çekiliyor
//! (`updater::release_notes_ready`).

use crate::geom;

pub const LABEL: &str = "release-notes";

const W: f64 = 760.0;
const H: f64 = 580.0;
const MIN_W: f64 = 560.0;
const MIN_H: f64 = 400.0;

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
            url: "release-notes/release-notes.html",
            width: W,
            height: H,
            transparent: true,
            decorations: false,
            resizable: true,
            // Güncelleme diyaloğu her zaman üstte; bu pencere ondan açılıyor ve onun
            // ARKASINDA kalmamalı.
            always_on_top: true,
            skip_taskbar: false,
            background: Some((0, 0, 0, 0)),
            visible: false,
            ..Default::default()
        },
    )?;
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(MIN_W, MIN_H)));

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
