//! Sentetik fare tekerleği ve imleç konumu — macOS.
//!
//! Windows'taki `platform::windows::scroll`'ün karşılığı; gerekçe orada anlatılıyor:
//! kaydırmalı yakalamada sayfayı uygulama çeviriyor, çünkü eşleştirici kare başına
//! bölgenin ~%42'sinden fazla kaymayı izleyemiyor ve bunu kullanıcıdan istemek
//! görünmez bir beceri talebi.
//!
//! `CGEventPost` — `paste.rs` ile aynı aile, aynı izin: **Erişilebilirlik**. İzin yoksa
//! olay sessizce yutuluyor; çağıran taraf sayfanın kıpırdamadığını ÖLÇEREK anlıyor ve
//! elle kipe düşüyor (bkz. scroller.js `autoMode`). Bu yüzden burada izin sorgusu yok:
//! ölçüm zaten her platformda gereken tek güvence.
//!
//! CoreGraphics olayları ana thread ŞARTI taşımıyor (AppKit'in aksine — bkz. mod.rs),
//! `paste.rs` de bunları doğrudan çağırıyor.

#![cfg(target_os = "macos")]

use std::ffi::c_void;

type CGEventSourceRef = *mut c_void;
type CGEventRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

const K_CG_HID_EVENT_TAP: u32 = 0;
const K_CG_EVENT_SOURCE_HID: u32 = 1;
/// `kCGScrollEventUnitLine` — "tık" birimi; Windows'taki WHEEL_DELTA'nın karşılığı.
/// Kaç piksel ettiği uygulamaya bağlı, çağıran taraf ölçüyor.
const K_CG_SCROLL_EVENT_UNIT_LINE: u32 = 1;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state: u32) -> CGEventSourceRef;
    fn CGEventCreateScrollWheelEvent(
        source: CGEventSourceRef,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
    ) -> CGEventRef;
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGEventCreate(source: CGEventSourceRef) -> CGEventRef;
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    fn CGWarpMouseCursorPosition(point: CGPoint) -> i32;
    /// Warp sonrası imleç ile gerçek fare arasındaki bağı hemen geri veriyor; yoksa
    /// kullanıcının bir sonraki hareketine kadar imleç "yapışık" kalıyor.
    fn CGAssociateMouseAndMouseCursorPosition(connected: i32) -> i32;
    fn CFRelease(cf: *mut c_void);
}

pub fn cursor_pos() -> Option<(f64, f64)> {
    // SAFETY: kaynaksız (`null`) olay yalnız o anki imleç konumunu taşır; ikisi de
    // kullanıldıktan sonra bırakılıyor.
    unsafe {
        let ev = CGEventCreate(std::ptr::null_mut());
        if ev.is_null() {
            return None;
        }
        let p = CGEventGetLocation(ev);
        CFRelease(ev);
        Some((p.x, p.y))
    }
}

pub fn set_cursor_pos(x: f64, y: f64) -> bool {
    // SAFETY: saf çağrılar.
    unsafe {
        let ok = CGWarpMouseCursorPosition(CGPoint { x, y }) == 0;
        CGAssociateMouseAndMouseCursorPosition(1);
        ok
    }
}

/// Tekerleği `notches` tık çevirir. POZİTİF = yukarı, NEGATİF = aşağı.
pub fn wheel(notches: i32) {
    if notches == 0 {
        return;
    }
    // SAFETY: `paste.rs` ile aynı kalıp — kaynak ve olay oluşturulup post ediliyor,
    // ikisi de bırakılıyor.
    unsafe {
        let source = CGEventSourceCreate(K_CG_EVENT_SOURCE_HID);
        let ev = CGEventCreateScrollWheelEvent(source, K_CG_SCROLL_EVENT_UNIT_LINE, 1, notches);
        if !ev.is_null() {
            CGEventPost(K_CG_HID_EVENT_TAP, ev);
            CFRelease(ev);
        }
        if !source.is_null() {
            CFRelease(source);
        }
    }
}
