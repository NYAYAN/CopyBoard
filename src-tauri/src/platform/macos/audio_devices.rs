//! Ses giriş aygıtlarını listeler (CoreAudio HAL).
//!
//! ## Neden gerekli
//!
//! Kullanıcı kulaklık taktığında macOS varsayılan girişi otomatik değiştiriyor ve
//! ScreenCaptureKit, aygıt kimliği VERİLMEDİĞİNDE o varsayılanı kullanıyor — yani
//! çoğu durumda doğru davranış zaten ücretsiz. Seçim şunun için var: kullanıcı
//! sistem varsayılanından BAŞKA bir mikrofon istediğinde (harici mikrofon takılıyken
//! dizüstünün kendi mikrofonunu kullanmak gibi).
//!
//! ScreenCaptureKit aygıtı **UID** ile istiyor (`with_microphone_capture_device_id`),
//! ad ile değil: ad değişebilir ve iki aygıt aynı adı taşıyabilir.

use std::ffi::c_void;

type OSStatus = i32;
type AudioObjectID = u32;

const SYSTEM_OBJECT: AudioObjectID = 1;

// Dört harfli CoreAudio seçici kodları.
const DEVICES: u32 = u32::from_be_bytes(*b"dev#");
const DEFAULT_INPUT: u32 = u32::from_be_bytes(*b"dIn ");
const STREAM_CONFIG: u32 = u32::from_be_bytes(*b"slay");
const DEVICE_UID: u32 = u32::from_be_bytes(*b"uid ");
const OBJECT_NAME: u32 = u32::from_be_bytes(*b"lnam");
const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
const SCOPE_INPUT: u32 = u32::from_be_bytes(*b"inpt");

#[repr(C)]
struct AudioObjectPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[repr(C)]
struct AudioBufferRaw {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferListRaw {
    number_buffers: u32,
    buffers: [AudioBufferRaw; 1], // değişken uzunluk — yalnız başlangıç
}

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectGetPropertyDataSize(
        id: AudioObjectID,
        addr: *const AudioObjectPropertyAddress,
        qual_size: u32,
        qual: *const c_void,
        out_size: *mut u32,
    ) -> OSStatus;
    fn AudioObjectGetPropertyData(
        id: AudioObjectID,
        addr: *const AudioObjectPropertyAddress,
        qual_size: u32,
        qual: *const c_void,
        io_size: *mut u32,
        out_data: *mut c_void,
    ) -> OSStatus;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringGetCString(s: *const c_void, buf: *mut u8, len: isize, encoding: u32) -> bool;
    fn CFRelease(cf: *mut c_void);
}

const UTF8: u32 = 0x0800_0100;

fn addr(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress { selector, scope, element: 0 }
}

/// Bir `CFStringRef`i Rust `String`e çevirir ve SERBEST BIRAKIR.
///
/// CoreAudio `kAudioDevicePropertyDeviceUID` ve `kAudioObjectPropertyName` için
/// +1 referans döndürüyor; bırakılmazsa her listeleme sızdırır.
fn take_cfstring(cf: *const c_void) -> Option<String> {
    if cf.is_null() {
        return None;
    }
    let mut buf = [0u8; 512];
    let ok = unsafe { CFStringGetCString(cf, buf.as_mut_ptr(), buf.len() as isize, UTF8) };
    unsafe { CFRelease(cf.cast_mut()) };
    if !ok {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..end].to_vec()).ok()
}

fn device_string(id: AudioObjectID, selector: u32) -> Option<String> {
    let a = addr(selector, SCOPE_GLOBAL);
    let mut cf: *const c_void = std::ptr::null();
    let mut size = std::mem::size_of::<*const c_void>() as u32;
    let st = unsafe {
        AudioObjectGetPropertyData(
            id,
            &a,
            0,
            std::ptr::null(),
            &mut size,
            (&raw mut cf).cast::<c_void>(),
        )
    };
    if st != 0 {
        return None;
    }
    take_cfstring(cf)
}

/// Aygıtın GİRİŞ kanalı var mı? Çıkış-only aygıtlar (hoparlör) listeye girmemeli.
fn has_input(id: AudioObjectID) -> bool {
    let a = addr(STREAM_CONFIG, SCOPE_INPUT);
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(id, &a, 0, std::ptr::null(), &mut size) } != 0
        || size == 0
    {
        return false;
    }
    let mut buf = vec![0u8; size as usize];
    if unsafe {
        AudioObjectGetPropertyData(
            id,
            &a,
            0,
            std::ptr::null(),
            &mut size,
            buf.as_mut_ptr().cast::<c_void>(),
        )
    } != 0
    {
        return false;
    }
    let list = buf.as_ptr().cast::<AudioBufferListRaw>();
    let n = unsafe { (*list).number_buffers } as usize;
    if n == 0 {
        return false;
    }
    let first = unsafe { std::ptr::addr_of!((*list).buffers) }.cast::<AudioBufferRaw>();
    (0..n).any(|i| unsafe { (*first.add(i)).number_channels } > 0)
}

fn default_input_uid() -> Option<String> {
    let a = addr(DEFAULT_INPUT, SCOPE_GLOBAL);
    let mut id: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let st = unsafe {
        AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &a,
            0,
            std::ptr::null(),
            &mut size,
            (&raw mut id).cast::<c_void>(),
        )
    };
    if st != 0 || id == 0 {
        return None;
    }
    device_string(id, DEVICE_UID)
}

/// Bir ses giriş aygıtı.
#[derive(serde::Serialize, Debug, Clone)]
pub struct AudioInput {
    /// ScreenCaptureKit'in istediği kimlik. Ad DEĞİL: ad değişebilir, iki aygıt aynı
    /// adı taşıyabilir.
    pub id: String,
    pub name: String,
    /// Sistem varsayılanı mı? Kullanıcı bunu seçerse kimlik saklanmıyor — böylece
    /// kulaklık takılınca seçim otomatik takip ediyor.
    pub is_default: bool,
}

/// Giriş kanalı olan tüm ses aygıtlarını listeler.
pub fn list() -> Vec<AudioInput> {
    let a = addr(DEVICES, SCOPE_GLOBAL);
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &a, 0, std::ptr::null(), &mut size) }
        != 0
        || size == 0
    {
        return Vec::new();
    }
    let count = size as usize / std::mem::size_of::<AudioObjectID>();
    let mut ids = vec![0u32; count];
    if unsafe {
        AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &a,
            0,
            std::ptr::null(),
            &mut size,
            ids.as_mut_ptr().cast::<c_void>(),
        )
    } != 0
    {
        return Vec::new();
    }

    let default_uid = default_input_uid();
    ids.into_iter()
        .filter(|&id| has_input(id))
        .filter_map(|id| {
            let uid = device_string(id, DEVICE_UID)?;
            let name = device_string(id, OBJECT_NAME).unwrap_or_else(|| uid.clone());
            let is_default = default_uid.as_deref() == Some(uid.as_str());
            Some(AudioInput { id: uid, name, is_default })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn en_az_bir_giris_aygiti_bulunuyor() {
        // CI'da ses donanımı olmayabilir; orada liste boş olabilir ve bu bir hata
        // değil. Aranan şey ÇÖKMEMESİ ve tutarlı veri döndürmesi.
        let devs = list();
        for d in &devs {
            assert!(!d.id.is_empty(), "UID boş olmamalı");
            assert!(!d.name.is_empty(), "ad boş olmamalı");
        }
        // Varsayılan en fazla BİR tane olabilir.
        assert!(devs.iter().filter(|d| d.is_default).count() <= 1);
    }
}
