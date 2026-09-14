//! Sentetik fare tekerleği ve imleç konumu — Windows.
//!
//! Kaydırmalı yakalamada sayfayı UYGULAMA çeviriyor (bkz. `commands::record::auto_scroll_*`).
//! Gerekçe: eşleştirici kare başına bölgenin ~%42'sinden fazla kaymayı izleyemiyor ve
//! bunu kullanıcıdan "yavaş kaydır" diye istemek görünmez bir beceri talebi. Tekerleği
//! biz çevirince adım bizim denetimimizde kalıyor.
//!
//! `SendInput` seçildi çünkü GERÇEK bir kullanıcı olayı üretiyor: olay imlecin altındaki
//! pencereye, o pencerenin kendi vurgu (hit-test) mantığıyla gidiyor. `PostMessage` ile
//! `WM_MOUSEWHEEL` yollamak HWND bulmayı gerektirirdi ve Chromium/WebView2 tabanlı
//! uygulamalarda güvenilir değil.
//!
//! ## Sınır
//!
//! UIPI: yükseltilmiş (elevated) bir pencereye yükseltilmemiş süreçten girdi gidemez.
//! Böyle bir durumda tekerlek sessizce yutuluyor; çağıran taraf sayfanın kıpırdamadığını
//! ÖLÇEREK anlıyor ve elle kipe düşüyor (bkz. scroller.js `autoMode`).

#![cfg(target_os = "windows")]

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos, WHEEL_DELTA};

/// İmlecin sanal masaüstü koordinatındaki FİZİKSEL konumu.
pub fn cursor_pos() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    // SAFETY: saf sorgu; `p` yığında ve geçerli.
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

pub fn set_cursor_pos(x: f64, y: f64) -> bool {
    // SAFETY: saf çağrı; ekran dışı koordinat en yakın sınıra kırpılır.
    unsafe { SetCursorPos(x.round() as i32, y.round() as i32).is_ok() }
}

/// Tekerleği `notches` tık çevirir. POZİTİF = yukarı, NEGATİF = aşağı (Win32 işareti).
///
/// Bir tık `WHEEL_DELTA` (120). Kaç piksel ettiği UYGULAMAYA ve kullanıcının
/// "bir seferde kaç satır" ayarına bağlı; çağıran taraf bunu ölçüp adımını ona göre
/// kuruyor, burada varsayım yok.
pub fn wheel(notches: i32) {
    if notches == 0 {
        return;
    }
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: (notches * WHEEL_DELTA as i32) as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    // SAFETY: tek bir olay, boyutu türden alınıyor.
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent != 1 {
        log::debug!("tekerlek gönderilemedi (UIPI / yükseltilmiş pencere olabilir)");
    }
}
