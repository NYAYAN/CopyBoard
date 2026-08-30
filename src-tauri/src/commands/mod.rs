//! Renderer'dan çağrılan komutlar.
//!
//! Electron'da 78 IPC kanalı vardı: 6'sı `invoke` (cevap dönen), 72'si `send`
//! (tek yön). Tauri'de bu ayrım yok — hepsi `invoke`, dönüşü olmayanların
//! sonucu yok sayılıyor. `api-tauri.js` eski `window.api` yüzeyini birebir
//! koruduğu için renderer bunu hiç fark etmiyor.

pub mod capture;
pub mod clipboard;
pub mod core;
pub mod gallery;
pub mod viewer;
pub mod widget;
pub mod ready;
pub mod record;
pub mod shortcuts;
