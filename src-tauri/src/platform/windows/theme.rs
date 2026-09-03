//! OS açık/koyu tema tercihi — pencere olmadan.
//!
//! `theme: 'system'` ilk pencere kurulurken çözülmek zorunda (`initialization_script`
//! sabitleniyor) ve o anda `Window::theme()` soracak bir pencere yok. Windows tercihi
//! kayıt defterinde: `AppsUseLightTheme` 0 ise koyu.

use windows::core::w;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

pub fn os_prefers_dark() -> Option<bool> {
    let mut value: u32 = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;
    // SAFETY: çıktı tamponu ve boyutu geçerli; RegGetValueW yalnız onları yazıyor.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut core::ffi::c_void),
            Some(&mut size),
        )
    };
    if status.is_ok() {
        Some(value == 0)
    } else {
        None
    }
}
