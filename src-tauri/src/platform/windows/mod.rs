//! Windows'a özgü davranışlar. Faz 2'de doldurulacak (pano formatları, SendInput,
//! WDA_EXCLUDEFROMCAPTURE). Şimdilik yalnız modül iskeleti.

#![allow(dead_code)]

pub mod clipboard_formats;
pub mod paste;

/// Windows'ta `always_on_top` zaten `HWND_TOPMOST` veriyor; ayrı bir seviye kavramı yok.
pub fn set_topmost(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.set_always_on_top(true).map_err(|e| e.to_string())
}
