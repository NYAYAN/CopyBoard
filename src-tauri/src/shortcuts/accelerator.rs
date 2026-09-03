//! Electron accelerator dizesi ↔ Tauri `Shortcut` çevirisi.
//!
//! ## Neden bu dosya var
//!
//! Kayıtlı kısayollar `config.json`'da **Electron biçiminde** duruyor
//! (`"CommandOrControl+Shift+V"`) ve göç dosyayı olduğu gibi kopyalıyor. Ayarlar
//! ekranındaki kaydedici (`src/renderer/main-window/modules/accelerator.js`) de aynı
//! biçimi üretiyor. Yani bu biçim değişmiyor; değişen, onu kimin çözdüğü.
//!
//! ## Neden `e.code` tabanlı
//!
//! Global kısayol FİZİKSEL tuşla eşleşir, tuşun bastığı karakterle değil. Kaydedici
//! bu yüzden `e.code` okuyor; buradaki tablo da onun ürettiği sözcük dağarcığının
//! birebir karşılığı. Tablo kayarsa kullanıcının kısayolu **sessizce başka bir tuşa**
//! bağlanır — kaydolur, çalışmaz. Testler tam olarak bunu bekliyor.
//!
//! ## Native-only tuşlar
//!
//! `IntlBackslash`, `IntlYen`, `IntlRo`, `Lang1`, `Lang2`: Electron'un adlandıramadığı,
//! Tauri'nin `global-hotkey` crate'inin de **açıkça reddettiği** fiziksel tuşlar
//! (Spike-8'de ölçüldü: `Unknown scancode for IntlBackslash`). Bunlar Tauri'ye HİÇ
//! verilmiyor; macOS'ta Carbon köprüsüne gidiyor. Yönlendirme [`is_native_only`] ile.

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

/// Electron'un adlandıramadığı, yalnız Carbon köprüsünün ulaşabildiği fiziksel tuşlar.
/// `accelerator.js`'teki `NATIVE_ONLY_CODES` ile birebir aynı olmak zorunda.
pub const NATIVE_ONLY_CODES: [&str; 5] = ["IntlBackslash", "IntlYen", "IntlRo", "Lang1", "Lang2"];

/// macOS sanal tuş kodları. `native/mac-hotkey/index.js`'teki `CODE_TO_KEYCODE`'un portu.
pub fn native_keycode(code: &str) -> Option<u32> {
    Some(match code {
        "IntlBackslash" => 0x0A, // kVK_ISO_Section — ISO klavyelerde Esc'in altı
        "IntlYen" => 0x5D,       // kVK_JIS_Yen
        "IntlRo" => 0x5E,        // kVK_JIS_Underscore
        "Lang1" => 0x68,         // kVK_JIS_Kana
        "Lang2" => 0x66,         // kVK_JIS_Eisu
        _ => return None,
    })
}

/// Bu accelerator, yalnız Carbon köprüsünün ulaşabileceği bir tuşu mu adlandırıyor?
///
/// Saf dize işi — native binary yüklenmeden önce ve o yüklenmeden yanıt vermeli,
/// çünkü böyle bir dizeyi Tauri'ye vermemek TAM OLARAK bu kontrolün işi.
pub fn is_native_only(accelerator: &str) -> bool {
    key_part(accelerator).is_some_and(|k| NATIVE_ONLY_CODES.contains(&k))
}

fn key_part(accelerator: &str) -> Option<&str> {
    accelerator.rsplit('+').next().map(str::trim).filter(|s| !s.is_empty())
}

/// Ayrıştırılmış accelerator: değiştiriciler + tuş adı.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed<'a> {
    pub key: &'a str,
    pub cmd_or_ctrl: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

impl Parsed<'_> {
    /// Cmd/Ctrl ailesinden herhangi biri var mı? Rezerve tuş kontrolü buna bakıyor.
    pub fn has_cmd_ctrl(&self) -> bool {
        self.cmd_or_ctrl || self.ctrl || self.meta
    }
}

pub fn parse(accelerator: &str) -> Option<Parsed<'_>> {
    let parts: Vec<&str> = accelerator.split('+').map(str::trim).filter(|s| !s.is_empty()).collect();
    let key = *parts.last()?;
    let mut p = Parsed { key, cmd_or_ctrl: false, ctrl: false, alt: false, shift: false, meta: false };

    for m in &parts[..parts.len() - 1] {
        match m.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" => p.cmd_or_ctrl = true,
            "control" | "ctrl" => p.ctrl = true,
            "alt" | "option" => p.alt = true,
            "shift" => p.shift = true,
            "command" | "cmd" | "super" | "meta" => p.meta = true,
            other => {
                log::warn!("bilinmeyen değiştirici '{other}' — '{accelerator}' yok sayıldı");
                return None;
            }
        }
    }
    Some(p)
}

/// Electron tuş adı → Tauri `Code`.
///
/// Kaynak: `accelerator.js`'in ürettiği tüm biçimler ARTI Electron'un `globalShortcut`
/// sözlüğünün geri kalanı. Sebebi göç: eski CopyBoard kaydedicileri `e.key` tabanlıydı
/// ve `config.json`da `CommandOrControl+Shift+!` ya da `Alt+Plus` gibi dizeler duruyor
/// olabilir; Electron bunları kaydediyordu. Tanınmayan bir ad `None` döner —
/// **yanlış bir tuşa düşmektense hiç bağlanmamak** doğrudur; çağıran o durumda
/// varsayılana döndürüp kullanıcıya söylüyor.
///
/// Electron adları büyük/küçük harfe duyarsızdı (`space`, `f5`, `pageup`); burada da öyle.
pub fn key_to_code(key: &str) -> Option<Code> {
    key_to_code_shifted(key).map(|(code, _)| code)
}

/// [`key_to_code`] artı "bu ad Shift gerektiriyor mu" bilgisi. Electron `"!"`ı
/// `Shift+1` olarak kaydediyordu: shift'li noktalama ana tuşa iner, Shift eklenir.
pub fn key_to_code_shifted(key: &str) -> Option<(Code, bool)> {
    // Harfler: "A".."Z"; rakamlar
    if key.len() == 1 {
        let c = key.as_bytes()[0];
        if c.is_ascii_alphabetic() {
            return letter_code(c.to_ascii_uppercase()).map(|k| (k, false));
        }
        if c.is_ascii_digit() {
            return digit_code(c).map(|k| (k, false));
        }
    }
    let lower = key.to_ascii_lowercase();
    // Numpad rakamları: "num0".."num9"
    if let Some(d) = lower.strip_prefix("num") {
        if d.len() == 1 && d.as_bytes()[0].is_ascii_digit() {
            return numpad_code(d.as_bytes()[0]).map(|k| (k, false));
        }
    }
    // Fonksiyon tuşları: "F1".."F24"
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
        return function_code(n).map(|k| (k, false));
    }

    let plain = match lower.as_str() {
        "space" => Code::Space,
        "tab" => Code::Tab,
        "enter" | "return" => Code::Enter,
        "backspace" => Code::Backspace,
        "delete" => Code::Delete,
        "insert" => Code::Insert,
        "home" => Code::Home,
        "end" => Code::End,
        "pageup" => Code::PageUp,
        "pagedown" => Code::PageDown,
        "up" => Code::ArrowUp,
        "down" => Code::ArrowDown,
        "left" => Code::ArrowLeft,
        "right" => Code::ArrowRight,
        "escape" | "esc" => Code::Escape,
        "," => Code::Comma,
        "." => Code::Period,
        "/" => Code::Slash,
        "\\" => Code::Backslash,
        ";" => Code::Semicolon,
        "'" => Code::Quote,
        "[" => Code::BracketLeft,
        "]" => Code::BracketRight,
        "`" => Code::Backquote,
        "-" => Code::Minus,
        "=" => Code::Equal,
        // Electron `Plus` = `=`/`+` tuşu (VKEY_OEM_PLUS)
        "plus" => Code::Equal,
        "numadd" => Code::NumpadAdd,
        "numsub" => Code::NumpadSubtract,
        "nummult" => Code::NumpadMultiply,
        "numdiv" => Code::NumpadDivide,
        "numdec" => Code::NumpadDecimal,
        // Electron'un geri kalan sözlüğü. Bazı platformlarda OS kaydı reddedebilir;
        // o zaman "kaydedilemedi" yolu devreye girer — sessiz yanlış tuş değil.
        "printscreen" => Code::PrintScreen,
        "capslock" => Code::CapsLock,
        "numlock" => Code::NumLock,
        "scrolllock" => Code::ScrollLock,
        "volumeup" => Code::AudioVolumeUp,
        "volumedown" => Code::AudioVolumeDown,
        "volumemute" => Code::AudioVolumeMute,
        "medianexttrack" => Code::MediaTrackNext,
        "mediaprevioustrack" => Code::MediaTrackPrevious,
        "mediastop" => Code::MediaStop,
        "mediaplaypause" => Code::MediaPlayPause,
        _ => {
            // Shift'li noktalama: Electron `KeyboardCodeFromCharCode` ile ana tuşa
            // indirip Shift ekliyordu (US düzeni varsayımıyla — Electron da öyle).
            let shifted = match key {
                "!" => Code::Digit1,
                "@" => Code::Digit2,
                "#" => Code::Digit3,
                "$" => Code::Digit4,
                "%" => Code::Digit5,
                "^" => Code::Digit6,
                "&" => Code::Digit7,
                "*" => Code::Digit8,
                "(" => Code::Digit9,
                ")" => Code::Digit0,
                ":" => Code::Semicolon,
                "\"" => Code::Quote,
                "<" => Code::Comma,
                ">" => Code::Period,
                "?" => Code::Slash,
                "_" => Code::Minus,
                "+" => Code::Equal,
                "{" => Code::BracketLeft,
                "}" => Code::BracketRight,
                "|" => Code::Backslash,
                "~" => Code::Backquote,
                _ => return None,
            };
            return Some((shifted, true));
        }
    };
    Some((plain, false))
}

/// Dize hiç çözümlenebiliyor mu? (`to_shortcut`'tan farkı: native-only tuşlar da
/// "çözümlenebilir" sayılır — onlar Carbon'a gidiyor, çözümsüz değil.)
pub fn is_parseable(accelerator: &str) -> bool {
    if is_native_only(accelerator) {
        return parse(accelerator).is_some();
    }
    parse(accelerator).is_some_and(|p| key_to_code(p.key).is_some())
}

fn letter_code(c: u8) -> Option<Code> {
    const LETTERS: [Code; 26] = [
        Code::KeyA, Code::KeyB, Code::KeyC, Code::KeyD, Code::KeyE, Code::KeyF, Code::KeyG,
        Code::KeyH, Code::KeyI, Code::KeyJ, Code::KeyK, Code::KeyL, Code::KeyM, Code::KeyN,
        Code::KeyO, Code::KeyP, Code::KeyQ, Code::KeyR, Code::KeyS, Code::KeyT, Code::KeyU,
        Code::KeyV, Code::KeyW, Code::KeyX, Code::KeyY, Code::KeyZ,
    ];
    LETTERS.get((c - b'A') as usize).copied()
}

fn digit_code(c: u8) -> Option<Code> {
    const DIGITS: [Code; 10] = [
        Code::Digit0, Code::Digit1, Code::Digit2, Code::Digit3, Code::Digit4,
        Code::Digit5, Code::Digit6, Code::Digit7, Code::Digit8, Code::Digit9,
    ];
    DIGITS.get((c - b'0') as usize).copied()
}

fn numpad_code(c: u8) -> Option<Code> {
    const PAD: [Code; 10] = [
        Code::Numpad0, Code::Numpad1, Code::Numpad2, Code::Numpad3, Code::Numpad4,
        Code::Numpad5, Code::Numpad6, Code::Numpad7, Code::Numpad8, Code::Numpad9,
    ];
    PAD.get((c - b'0') as usize).copied()
}

fn function_code(n: u8) -> Option<Code> {
    const F: [Code; 24] = [
        Code::F1, Code::F2, Code::F3, Code::F4, Code::F5, Code::F6, Code::F7, Code::F8,
        Code::F9, Code::F10, Code::F11, Code::F12, Code::F13, Code::F14, Code::F15,
        Code::F16, Code::F17, Code::F18, Code::F19, Code::F20, Code::F21, Code::F22,
        Code::F23, Code::F24,
    ];
    if n == 0 { return None; }
    F.get((n - 1) as usize).copied()
}

/// Electron accelerator dizesini Tauri `Shortcut`'ına çevirir.
///
/// Native-only tuşlar için `None` döner — onlar Tauri'ye hiç verilmemeli.
pub fn to_shortcut(accelerator: &str) -> Option<Shortcut> {
    if is_native_only(accelerator) {
        return None;
    }
    let p = parse(accelerator)?;
    let (code, needs_shift) = key_to_code_shifted(p.key)?;

    let mut mods = Modifiers::empty();
    if needs_shift {
        mods |= Modifiers::SHIFT;
    }
    // `CommandOrControl`: macOS'ta Cmd, diğer her yerde Ctrl — Electron'un tanımı.
    if p.cmd_or_ctrl {
        if cfg!(target_os = "macos") {
            mods |= Modifiers::SUPER;
        } else {
            mods |= Modifiers::CONTROL;
        }
    }
    if p.meta {
        mods |= Modifiers::SUPER;
    }
    if p.ctrl {
        mods |= Modifiers::CONTROL;
    }
    if p.alt {
        mods |= Modifiers::ALT;
    }
    if p.shift {
        mods |= Modifiers::SHIFT;
    }

    Some(Shortcut::new(if mods.is_empty() { None } else { Some(mods) }, code))
}

/// Kullanıcıya gösterilecek biçim: `"CommandOrControl+Shift+V"` → `"Cmd + Shift + V"`.
///
/// Fiziksel kod adları (`IntlBackslash`) hiçbir kullanıcıya bir şey ifade etmiyor;
/// yerine o tuşun YAYGIN durumda bastığı karakter gösteriliyor. Ayarlar ekranı gerçek
/// keycap'i klavye düzeninden okuyor; burası (toast ve tepsi) için dürüst olan bu.
pub fn to_display(accelerator: &str) -> String {
    const KEYCAPS: [(&str, &str); 5] = [
        ("IntlBackslash", "\""),
        ("IntlYen", "¥"),
        ("IntlRo", "_"),
        ("Lang1", "かな"),
        ("Lang2", "英数"),
    ];
    let is_mac = cfg!(target_os = "macos");

    accelerator
        .split('+')
        .map(|raw| {
            let raw = raw.trim();
            match raw.to_ascii_lowercase().as_str() {
                "commandorcontrol" | "cmdorctrl" => if is_mac { "Cmd" } else { "Ctrl" }.to_string(),
                "command" | "cmd" | "super" | "meta" => "Cmd".into(),
                "control" | "ctrl" => "Ctrl".into(),
                "option" => "Option".into(),
                _ => KEYCAPS
                    .iter()
                    .find(|(c, _)| *c == raw)
                    .map(|(_, cap)| (*cap).to_string())
                    .unwrap_or_else(|| raw.to_string()),
            }
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electron_varsayilanlari_cevriliyor() {
        // state.js'teki gerçek varsayılanlar. Biri çevrilemezse kullanıcı o kısayolu
        // güncelleme sonrası kaybeder.
        for accel in ["Alt+V", "Alt+9", "Alt+8", "Alt+2", "Alt+3", "Alt+4", "CommandOrControl+Shift+V"] {
            assert!(to_shortcut(accel).is_some(), "'{accel}' çevrilemedi");
        }
    }

    #[test]
    fn commandorcontrol_platforma_gore_cozuluyor() {
        let s = to_shortcut("CommandOrControl+Shift+V").unwrap();
        let expected = if cfg!(target_os = "macos") {
            Modifiers::SUPER | Modifiers::SHIFT
        } else {
            Modifiers::CONTROL | Modifiers::SHIFT
        };
        assert_eq!(s.mods, expected);
        assert_eq!(s.key, Code::KeyV);
    }

    #[test]
    fn native_only_tuslar_tauriye_verilmiyor() {
        // Spike-8: global-hotkey `Unknown scancode for IntlBackslash` diyor.
        // Bunları Tauri'ye vermek hataya değil, YANLIŞ TUŞA bağlanmaya yol açabilirdi.
        for code in NATIVE_ONLY_CODES {
            let accel = format!("CommandOrControl+{code}");
            assert!(is_native_only(&accel), "{code} native-only tanınmadı");
            assert!(to_shortcut(&accel).is_none(), "{code} Tauri'ye verildi");
            assert!(native_keycode(code).is_some(), "{code} için keycode yok");
        }
    }

    #[test]
    fn accelerator_js_tablosunun_tamami_cevriliyor() {
        // accelerator.js'teki CODE_TO_ACCELERATOR'ın DEĞERLERİ. Kaydedici bunları
        // üretebiliyorsa, buranın hepsini çözebilmesi gerekir.
        let produced = [
            "Space", "Tab", "Enter", "Backspace", "Delete", "Insert", "Home", "End",
            "PageUp", "PageDown", "Up", "Down", "Left", "Right",
            ",", ".", "/", "\\", ";", "'", "[", "]", "`", "-", "=",
            "numadd", "numsub", "nummult", "numdiv", "numdec",
        ];
        for key in produced {
            assert!(key_to_code(key).is_some(), "'{key}' çevrilemedi — kaydedici bunu üretebiliyor");
        }
        // Harf, rakam, numpad, fonksiyon aileleri
        for c in b'A'..=b'Z' {
            let k = (c as char).to_string();
            assert!(key_to_code(&k).is_some(), "'{k}' çevrilemedi");
        }
        for d in 0..=9 {
            assert!(key_to_code(&d.to_string()).is_some());
            assert!(key_to_code(&format!("num{d}")).is_some());
        }
        for n in 1..=24 {
            assert!(key_to_code(&format!("F{n}")).is_some(), "F{n} çevrilemedi");
        }
    }

    #[test]
    fn tuslar_dogru_koda_gidiyor_yakinina_degil() {
        // Bu testin varlık sebebi: yanlış eşleme sessizce BAŞKA bir tuşa bağlar.
        assert_eq!(key_to_code("A"), Some(Code::KeyA));
        assert_eq!(key_to_code("Z"), Some(Code::KeyZ));
        assert_eq!(key_to_code("0"), Some(Code::Digit0));
        assert_eq!(key_to_code("9"), Some(Code::Digit9));
        assert_eq!(key_to_code("num0"), Some(Code::Numpad0));
        assert_eq!(key_to_code("F1"), Some(Code::F1));
        assert_eq!(key_to_code("F24"), Some(Code::F24));
        assert_eq!(key_to_code("Up"), Some(Code::ArrowUp));
        assert_eq!(key_to_code("\\"), Some(Code::Backslash));
        assert_eq!(key_to_code("'"), Some(Code::Quote));
    }

    #[test]
    fn taninmayan_tus_yanlis_tusa_dusmuyor() {
        assert_eq!(key_to_code("F0"), None);
        assert_eq!(key_to_code("F25"), None);
        assert_eq!(key_to_code("num10"), None);
        assert_eq!(key_to_code("Ş"), None);
        assert_eq!(key_to_code(""), None);
        assert!(to_shortcut("Alt+Ş").is_none());
    }

    #[test]
    fn electron_miras_adlari_cozuluyor() {
        // Eski (`e.key` tabanlı) kaydedicilerin config.json'a yazdığı ve Electron'un
        // kabul ettiği biçimler. Çözülemezse göç sonrası kısayol sessizce ölür.
        assert_eq!(key_to_code("space"), Some(Code::Space));
        assert_eq!(key_to_code("f5"), Some(Code::F5));
        assert_eq!(key_to_code("Plus"), Some(Code::Equal));
        assert_eq!(key_to_code("PrintScreen"), Some(Code::PrintScreen));
        assert_eq!(key_to_code("VolumeMute"), Some(Code::AudioVolumeMute));
        // Shift'li noktalama ana tuşa iner ve Shift eklenir
        assert_eq!(key_to_code_shifted("!"), Some((Code::Digit1, true)));
        assert_eq!(key_to_code_shifted("\""), Some((Code::Quote, true)));
        let s = to_shortcut("CommandOrControl+!").unwrap();
        assert!(s.mods.contains(Modifiers::SHIFT), "Shift eklenmedi");
        assert_eq!(s.key, Code::Digit1);
        // Ayrıştırılabilirlik: native-only tuş da "çözümlenebilir"
        assert!(is_parseable("CommandOrControl+IntlBackslash"));
        assert!(is_parseable("Alt+9"));
        assert!(!is_parseable("Alt+Ş"));
        assert!(!is_parseable("AltGr+X"));
    }

    #[test]
    fn degistiriciler_ayristiriliyor() {
        let p = parse("CommandOrControl+Alt+Shift+K").unwrap();
        assert!(p.cmd_or_ctrl && p.alt && p.shift);
        assert!(!p.ctrl && !p.meta);
        assert_eq!(p.key, "K");
        assert!(p.has_cmd_ctrl());

        let p = parse("Alt+9").unwrap();
        assert!(!p.has_cmd_ctrl());
        assert!(p.alt);
    }

    #[test]
    fn gosterim_bicimi() {
        let cmd = if cfg!(target_os = "macos") { "Cmd" } else { "Ctrl" };
        assert_eq!(to_display("CommandOrControl+Shift+V"), format!("{cmd} + Shift + V"));
        assert_eq!(to_display("Alt+9"), "Alt + 9");
        // Fiziksel kod adı yerine keycap
        assert_eq!(to_display("CommandOrControl+IntlBackslash"), format!("{cmd} + \""));
    }
}
