//! Windows pano erişimi.
//!
//! macOS tarafıyla aynı iki gerekçe: `GetClipboardSequenceNumber` ile ucuz değişim
//! tespiti, ve parola yöneticilerinin yazdığı sentinel formatların tanınması.
//!
//! Windows'ta üç farklı sentinel format dolaşımda — hangisini yazacağı uygulamaya
//! göre değişiyor, bu yüzden üçü de kontrol ediliyor.

use windows::core::w;
use windows::Win32::System::DataExchange::{
    GetClipboardSequenceNumber, IsClipboardFormatAvailable, RegisterClipboardFormatW,
};

const CONCEALED_FORMATS: [windows::core::PCWSTR; 3] = [
    w!("Clipboard Viewer Ignore"),
    w!("ExcludeClipboardContentFromMonitorProcessing"),
    w!("CanIncludeInClipboardHistory"),
];

pub fn change_count() -> i64 {
    unsafe { GetClipboardSequenceNumber() as i64 }
}

pub fn is_concealed() -> bool {
    CONCEALED_FORMATS.iter().any(|name| unsafe {
        let id = RegisterClipboardFormatW(*name);
        id != 0 && IsClipboardFormatAvailable(id).is_ok()
    })
}

/// Windows'ta metin okuma/yazma için `arboard` yeterli — sentinel formatların
/// aksine standart bir yol var ve arboard OpenClipboard yarışlarını zaten
/// yeniden deniyor.
pub fn read_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

pub fn write_text(text: &str) -> bool {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text.to_string()))
        .is_ok()
}
