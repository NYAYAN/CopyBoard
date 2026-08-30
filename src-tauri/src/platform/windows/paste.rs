//! Windows'ta odaktaki uygulamaya Ctrl+V göndermek.
//!
//! ## Electron'a göre kazanç: bir süreç daha az
//!
//! Electron sürümü SICAK BİR POWERSHELL SÜRECİ tutuyordu: `Add-Type` ile bir
//! `keybd_event` sarmalayıcısı tanımlıyor, her yapıştırmada stdin'e `Send-Paste`
//! yazıyordu. Sebebi `WScript.Shell.SendKeys`'in NumLock'u toggle etmesiydi.
//! Ayrıca ilk `Add-Type` derlemesini gizlemek için bir "ısıtma" mekanizması gerekiyordu.
//!
//! Rust'tan `SendInput` doğrudan çağrılabildiği için bunların hepsi gidiyor:
//! süreç yok, ısıtma yok, stdin borusu yok, NumLock yan etkisi yok.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_V,
};

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub fn send_paste() {
    let inputs = [
        key(VK_CONTROL, false),
        key(VK_V, false),
        key(VK_V, true),
        key(VK_CONTROL, true),
    ];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        log::warn!("SendInput eksik gönderdi: {sent}/{}", inputs.len());
    }
}

/// Windows'ta "önceki uygulamayı hatırla" gerekmiyor: yapıştırma, ön plandaki
/// pencereye giden düz bir Ctrl+V ve picker odağı bırakınca o pencere altındaki
/// uygulamaya geri dönüyor.
pub fn note_front_app() {}
