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
//!
//! ## Hedef pencere
//!
//! Seçici `focusable: false` olduğu için kısayolla açıldığında odak kullanıcının
//! penceresinde kalıyor ve düz bir Ctrl+V doğru yere gidiyor. Ama seçici WIDGET'tan
//! açıldığında widget penceresi odaklanabilir ve tıklama onu ön plana getiriyor:
//! Ctrl+V widget'a gidiyordu. Electron win32'de bunun için widget'ı `blur()` ediyordu.
//! Burada macOS'taki modelin aynısı: imleç widget'a girerken ön plandaki pencere
//! not ediliyor (`note_front_app`, hit-test'ten çağrılıyor) ve yapıştırmadan önce
//! `SetForegroundWindow` ile ona dönülüyor.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
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

/// Hatırlanan hedef pencere (HWND'nin ham değeri; `HWND` `Send` değil).
static FRONT_WINDOW: Mutex<Option<(isize, Instant)>> = Mutex::new(None);
/// macOS tarafıyla aynı: "üzerine gel → tıkla → listeyi oku → seç" akışını atlatacak kadar.
const FRONT_TTL: Duration = Duration::from_secs(120);

fn is_own_window(hwnd: HWND) -> bool {
    let mut pid: u32 = 0;
    // SAFETY: geçerli/geçersiz her HWND için güvenli; pid çıktısı yerel değişken.
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid == std::process::id()
}

/// Ön plandaki pencereyi hatırla — CopyBoard'un kendi penceresi DEĞİLSE.
pub fn note_front_app() {
    // SAFETY: yan etkisiz sorgu.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return;
    }
    let mut slot = FRONT_WINDOW.lock().unwrap();
    if !is_own_window(hwnd) {
        *slot = Some((hwnd.0 as isize, Instant::now()));
        return;
    }
    // Öndeki biziz (widget/tepsi tıklaması): gerçek hedefi TUT, yalnız bayatlamışı düşür.
    if slot.as_ref().is_some_and(|(_, at)| at.elapsed() > FRONT_TTL) {
        *slot = None;
    }
}

/// Hatırlanan pencereye dön. Yoksa ya da öndeki zaten o ise işlemsiz.
fn reactivate_target() {
    let target = {
        let slot = FRONT_WINDOW.lock().unwrap();
        slot.as_ref().filter(|(_, at)| at.elapsed() <= FRONT_TTL).map(|(h, _)| *h)
    };
    let Some(raw) = target else { return };
    let hwnd = HWND(raw as *mut core::ffi::c_void);
    // SAFETY: HWND artık geçersiz olabilir; IsWindow önce soruluyor, SetForegroundWindow
    // başarısızlığı yalnız bir bool.
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return;
        }
        if GetForegroundWindow() == hwnd {
            return;
        }
        if !SetForegroundWindow(hwnd).as_bool() {
            log::debug!("SetForegroundWindow reddedildi — Ctrl+V ön plandaki pencereye gidiyor");
            return;
        }
        // Odağın oturması için kısa bir an (macOS tarafındaki 60 ms ile aynı gerekçe).
        std::thread::sleep(Duration::from_millis(60));
    }
}

pub fn send_paste() {
    reactivate_target();
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
