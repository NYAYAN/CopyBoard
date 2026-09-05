# Faz 0 — Spike Sonuçları

> Ölçüm tarihi: 2026-08-30 · macOS 26.5.2 (Mac15,3, arm64) · Rust 1.98.0 · Tauri 2.11.5
> Test donanımı: 2 monitör — 3600×2338 @2x (dahili) + 3440×1440 @1x (harici)
> [Göç planı](TAURI_MIGRATION_PLAN.md) §6'daki sorulara verilen ölçülmüş yanıtlar.

| Spike | Soru | Sonuç |
|---|---|---|
| **S1** | 6 pencere tipinin bayrakları kurulabiliyor mu? | ✅ **GEÇTİ** |
| **S2** | `focusable:false` odak çalıyor mu? | ✅ **GEÇTİ** |
| **S3** | xcap çok monitör / çok DPI kalitesi? | ✅ **GEÇTİ** (Electron'dan hızlı) |
| **S7** | `initialization_script` sayfa scriptlerinden önce mi? | ✅ **GEÇTİ** |
| **S8** | Carbon hotkey Rust'tan çalışıyor, Tauri ile çakışmıyor mu? | ✅ **GEÇTİ** — gerçek tuş basımıyla doğrulandı |
| **S4** | ScreenCaptureKit → kırpılmış, sesli mp4? | ✅ **GEÇTİ** — üç aşama da |
| **S6** | tesseract-rs eng+tur? | ✅ **GEÇTİ** (cmake tarball ile) |
| **S5** | Kare akışı Channel'da 15 fps? | ✅ **GEÇTİ** — 234 MB/sn, sıfır kare düşümü |
| **S9–S11** | Linux X11 / Wayland / WebKitGTK | ⏳ Linux makinesi gerekiyor |

## 🟢 KAPI AÇILDI

**Zorunlu dördün dördü de geçti: S1 ✅ S2 ✅ S4 ✅ S7 ✅.**
Projeyi durdurabilecek tek risk (video kaydı) ölçümle kapatıldı — ffmpeg yedek planına
gerek yok, plan yazıldığı gibi yürüyor.

---

## S1 — Pencere bayrakları ✅

`spikes/s1-windows` · CopyBoard'un 6 pencere tipi gerçek bayraklarıyla kuruldu, ekran görüntüsüyle doğrulandı.

| Bayrak | Sonuç |
|---|---|
| `decorations(false)` (frameless) | ✅ |
| `transparent(true)` + `macOSPrivateApi` | ✅ masaüstü duvar kâğıdı pencerenin içinden görünüyor |
| `window-vibrancy` → `UnderWindowBackground` + `Active` | ✅ |
| `NSWindow.setLevel(1000)` (Electron `screen-saver`) | ✅ diğer uygulamaların üstünde |
| `NSWindow.setLevel(101)` (Electron `pop-up-menu`) | ✅ |
| `setCollectionBehavior(CanJoinAllSpaces \| FullScreenAuxiliary \| IgnoresCycle)` | ✅ |
| `set_visible_on_all_workspaces(true)` | ✅ |
| `content_protected(true)` | ✅ |
| `set_ignore_cursor_events(true)` | ✅ |
| `shadow(false)`, `skip_taskbar(true)`, `focusable(false)`, `resizable/maximizable` | ✅ |
| Tam monitör overlay (mantıksal 1800×1169 → fiziksel 3600×2338) | ✅ |

### 🔴 BULGU S1-a — AppKit FFI ana thread zorunluluğu

İlk çalıştırma **SIGTRAP ile öldü**:

```
exception: EXC_BREAKPOINT (SIGTRAP)
asi: libsystem_c.dylib  "Must only be used from the main thread"
  AppKit  -[NSWindow _applyWindowLevelWithTagUpdateNeeded:]
  s8...   objc2_app_kit::NSWindow::setLevel
  s1...   set_ns_level
  s1...   spawn_probe                        ← Tauri komutu = worker thread
```

Tauri komutları (async **ve** sync) async runtime'ın worker thread'inde koşar. AppKit'in
`NSWindow` API'lerinin tamamı yalnız ana thread'den çağrılabilir.

**Kural (gerçek uygulamada `platform/macos/*` modüllerinin TAMAMI için):**
her AppKit dokunuşu `window.run_on_main_thread()` içinden yapılacak; sonucu geri almak
için tek seferlik `mpsc` kanalı. Bu; `setLevel`, `setCollectionBehavior`, `apply_vibrancy`,
`NSApp.activate`, `NSPasteboard`, `AXIsProcessTrusted` — hepsi için geçerli.

```rust
fn on_main<F, T>(win: &tauri::WebviewWindow, f: F) -> Result<T, String>
where F: FnOnce() -> T + Send + 'static, T: Send + 'static {
    let (tx, rx) = std::sync::mpsc::channel();
    win.run_on_main_thread(move || { let _ = tx.send(f()); })
       .map_err(|e| format!("run_on_main_thread: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(3))
       .map_err(|e| format!("ana thread yanıt vermedi: {e}"))
}
```

> Bu bulgu tek başına Faz 0'ı haklı çıkarır: Faz 5'te widget kodunun ortasında keşfedilseydi,
> "bazen çöküyor" diye günlerce kovalanacak bir hata olurdu.

### 🟡 BULGU S1-b — Mantıksal ↔ fiziksel piksel, ölçülmüş

| API | Birim | Ölçülen (2x monitör) |
|---|---|---|
| `WebviewWindowBuilder::inner_size` / `position` | **mantıksal** | 1800×1169 → pencere 3600×2338 fiziksel |
| `Window::outer_position()` / `outer_size()` | **fiziksel** | (80,80) mantıksal → (160,160) fiziksel |
| `Monitor::size()` / `position()` / `work_area()` | **fiziksel** | work_area = `{x:0, y:78, w:3600, h:2148}` |

`work_area.y = 78` fiziksel = 39 mantıksal (menü çubuğu). Plan §5.7'deki `geom.rs` kuralı
ölçümle doğrulandı: monitör verisi okunur okunmaz mantıksala çevrilmeli.

---

## S2 — `focusable:false` odak davranışı ✅

Odak **başka bir uygulamadaydı** (test ideal koşulda çalıştı). Quick-Paste penceresi
`show()` ile açıldı, `set_focus()` çağrılmadı:

```json
"S2_quickpaste_did_not_take_focus": true,
"S2_focus_owner_unchanged": true,
"S2_owner_before": null,      // odak Tauri dışı bir uygulamada
"S2_owner_after":  null       // ...ve orada KALDI
```

Hızlı Yapıştır'ın tüm mimarisi buna bağlıydı; `NSPanel` yedek planına (§5.11) gerek yok.

---

## S3 — xcap yakalama ✅

`spikes/s3-capture` · İki monitör, 3 tur, release build.

| | 3600×2338 @2x | 3440×1440 @1x |
|---|---:|---:|
| **Yerel çözünürlük** | ✅ 3600×2338 | ✅ 3440×1440 |
| İlk kare boş mu? | hayır | hayır |
| capture (ilk / sonraki) | 103 ms / **26–36 ms** | 31 ms / **26 ms** |
| ham RGBA | 32,1 MB / 0 ms | 18,9 MB / 0 ms |
| PNG (varsayılan) | 3,6 MB / **34 ms** | 2,2 MB / **15 ms** |
| PNG (fast) | 30,3 MB / 30 ms | 16,7 MB / 16 ms |
| JPEG q85 | 0,6 MB / 65 ms | 0,8 MB / 40 ms |

**Elektron'a göre kazançlar:**
- Her monitör **kendiliğinden kendi yerel çözünürlüğünde** geliyor. `capture-service.js`
  bunu monitör başına ayrı `getSources()` çağırarak zar zor elde ediyordu (tek bir
  `thumbnailSize` tüm çağrıya uygulandığı için düşük DPI ekranlar bulanıklaşıyordu).
  xcap'ta bu sorun **yok**.
- **İlk kare boş gelmedi.** Electron'daki 5 denemeli retry döngüsünün (ScreenCaptureKit
  ısınma sorunu) karşılığı gerekmeyebilir. Yine de savunma amaçlı 2 denemelik hafif bir
  retry bırakılacak — makine/GPU çeşitliliği tek bir ölçümle kapatılmaz.

### 🟡 BULGU S3-a — Debug build ölçüm yapmaya uygun değil

| | debug | release | fark |
|---|---:|---:|---:|
| PNG encode (3600×2338) | 2890 ms | **34 ms** | **85×** |
| capture | 468 ms | 36 ms | 13× |

`image` crate'i debug'da felaket yavaş. **Kural: performansla ilgili her ölçüm
`--release` ile alınacak**, ve geliştirme sırasında `[profile.dev.package."*"] opt-level = 3`
kullanılacak — yoksa "Tauri Electron'dan yavaş" diye yanlış bir sonuca varılır.

### 🟢 KARAR S3-b — Overlay'e ham RGBA mı, PNG mi?

Ham RGBA 0 ms encode ama 32 MB IPC; PNG 34 ms encode ama 3,6 MB IPC + webview decode.
**Karar S5'e bırakıldı** — Channel throughput ölçümü ikisini de yanıtlayacak.
PNG yalnız diske kaydederken ve panoya yazarken kesinlikle gerekli.

---

## S7 — `initialization_script` sırası ✅

Altı probe sayfasının **tamamında**:

```json
{ "bootPresent": true, "dictOk": true, "backdropFilter": true, "dpr": 2.0 }
```

`window.__COPYBOARD_BOOT__` sayfanın **ilk `<script>`'i çalıştığında hazırdı**; o script
`document.documentElement.dataset.theme`'i bastı ve "tema yok" durumunu belli eden kırmızı
arka plan hiçbir pencerede görünmedi. `i18n.dict['Kaydet'] === 'Save'` doğrulandı.

**Yan bulgu:** `backdrop-filter` WKWebView'da destekleniyor (16 kullanım güvende),
`devicePixelRatio = 2.0` doğru raporlanıyor.

---

## S8 — Carbon hotkey ✅

`spikes/s8-hotkey`

```json
"carbon_handler_installed": true,
"carbon_registrations": {
  "Cmd+IntlBackslash (kVK_ISO_Section)": "✅ kayıtlı",   ← Türkçe-Q'da " tuşu
  "Cmd+IntlYen (kVK_JIS_Yen)":           "✅ kayıtlı",
  "Cmd+IntlRo (kVK_JIS_Underscore)":     "✅ kayıtlı"
},
"tauri_global_shortcut": {
  "Alt+Digit9":        "✅ kayıtlı",
  "Alt+Digit8":        "✅ kayıtlı",
  "Cmd+Shift+KeyV":    "✅ kayıtlı",
  "Cmd+IntlBackslash": "❌ Unable to register hotkey: Unknown scancode for IntlBackslash"
}
```

**Kaynak kodundan okunan iddia ölçümle doğrulandı:** `global-hotkey` crate'i
`Code::IntlBackslash` için macOS keycode'u bilmiyor ve **açıkça hata veriyor**.
Carbon FFI opsiyonel değil, zorunlu.

Her iki mekanizma aynı süreçte yan yana kuruldu, **SIGTRAP yok** — `mac_hotkey.mm`'in
1. kuralı (dispatcher target'a kayıt + yabancı hot key'i `eventNotHandledErr` ile geçirme)
Rust portunda da doğru uygulandı.

### El ile doğrulama — tamamlandı ✅

ISO klavyede gerçek tuş basımlarıyla (2026-08-30 13:27):

```
13:27:45  [tauri]   Alt+Digit9
13:27:45  [tauri]   Alt+Digit9          ← İKİ KEZ
13:27:36  [carbon]  Cmd + " (ISO Section)    ← TETİKLENDİ ✅
13:27:32  [carbon]  Cmd + Option + K (kontrol grubu)
13:27:25  [tauri]   Alt+Digit8
13:27:25  [tauri]   Alt+Digit8          ← İKİ KEZ
```

**`Cmd + "` gerçekten tetiklendi.** Electron'un adlandıramadığı, Tauri eklentisinin
`Unknown scancode` diye reddettiği fiziksel tuş, Carbon FFI ile Rust'tan yakalanıyor.
Türkçe-Q kullanıcılarının kısayolu göçte korunuyor.

### 🔴 BULGU S8-a — Tauri global-shortcut handler'ı İKİ KEZ tetikleniyor

Yukarıdaki logda her Tauri kısayolu iki satır, her Carbon kısayolu bir satır.

**Sebep:** `tauri-plugin-global-shortcut`, `global_hotkey` crate'inin `GlobalHotKeyEvent`'ini
handler'a **olduğu gibi** iletiyor. O olayın bir `state` alanı var (`Pressed` / `Released`)
ve handler **her ikisinde de** çağrılıyor. Plugin kaynağından:

```rust
move |_app: &AppHandle<R>, shortcut: &Shortcut, e: ShortcutEvent| {
    let js_event = ShortcutJsEvent { id: e.id, state: e.state, ... };
    let _ = handler.send(js_event);      // ← filtreleme YOK
}
```

**CopyBoard'da bunun anlamı:** `Alt+9`'a bir basış = **iki ekran görüntüsü**,
`Alt+8` = iki video kaydı başlatma denemesi, `Cmd+Shift+V` = picker aç-kapa (kendi
kendini iptal eder). Yani yedi kısayolun tamamı bozuk çalışırdı.

**Düzeltme — `shortcuts.rs`'te zorunlu:**

```rust
gs.on_shortcut(sc, move |_app, _shortcut, event| {
    if event.state != ShortcutState::Pressed { return; }   // ← bu satır olmazsa her şey iki kez
    action();
})?;
```

Carbon yolu bu sorunu **yapısal olarak** yaşamıyor: handler yalnız
`kEventHotKeyPressed` tipine kayıtlı, bırakma olayı hiç gelmiyor.

> Electron'un `globalShortcut.register()`'ı yalnız basmada tetiklediği için mevcut kodda
> böyle bir filtre yok. Bire bir port edilseydi, yedi kısayol da çift çalışırdı ve bu
> "bazen iki tane açılıyor" diye kovalanacak bir hata olurdu.

### 🟡 BULGU S8-b — `EventHotKeyRef`'ler saklanmalı

`RegisterEventHotKey`'in döndürdüğü ref ham bir pointer (`Copy`); Rust tarafında
düşürmek hiçbir şey yapmaz, kayıt Carbon'un global tablosunda yaşar. Kaydı kaldırmanın
**tek yolu** `UnregisterEventHotKey(ref)`. Kullanıcı Ayarlar'dan kısayolu değiştirdiğinde
eskisinin bırakılabilmesi için üretimde `accelerator → EventHotKeyRef` haritası tutulmalı
(mevcut `native/mac-hotkey/index.js`'teki `byAccelerator` haritasının karşılığı).

---

## S4 — Video kaydı ✅ (kapı spike'ı)

`spikes/s4-recorder` · Üç aşamada ölçüldü.

### Aşama A+B — kırpılmış kare akışı + sistem sesi

```
kırpma  : 1280x720 nokta @ (200, 150)
çıktı   : 2560x1440 piksel, 30 fps, BGRA
─────────────────────────────────────────────────────
A) video kareleri : 180   (ilk kare 299 ms sonra)
   ölçülen fps    : 29.4  (hedef 30)
   kare boyutu    : 2560x1440   ✅ kırpma uygulandı
B) ses buffer'ları: 302   ✅ SİSTEM SESİ VAR — sanal aygıt gerekmedi
```

### 🟢 KAZANIM S4-c — macOS'ta sistem sesi artık BlackHole istemiyor

Bugünkü Electron sürümü macOS'ta sistem sesini `getDisplayMedia` + `audio:'loopback'`
ile almaya çalışıyor ve çoğu zaman alamıyor; `recorder.js` bu durumda kullanıcıya
*"BlackHole gibi bir sanal ses aygıtı gerekebilir"* diyor.

ScreenCaptureKit'in `with_captures_audio(true)` ayarı sistem sesini **doğrudan** veriyor.
302 ses buffer'ı ölçüldü. Bu bir geriye gidiş değil, **özellik iyileşmesi**.

### Aşama C — H.264 encode + mp4 mux

```
codec   : H.264, mp4, sistem sesi açık
kullanılabilir codec'ler   : [H264, HEVC]
kullanılabilir dosya tipleri: [MP4, MOV]
kayıt başladı : true
kayıt bitti   : true
mp4 dosyası   : 0.27 MB ✅
```

Dosya `qlmanage` ile çözüldü ve kırpılmış bölgenin doğru içeriğini gösterdi →
**geçerli, oynatılabilir H.264/mp4.**

### 🔴 BULGU S4-a — Swift runtime rpath'i

İlk çalıştırma dyld ile öldü:

```
dyld: Library not loaded: @rpath/libswift_Concurrency.dylib
      Reason: no LC_RPATH's found
```

ScreenCaptureKit Swift concurrency runtime'ına bağlanır; Cargo'nun ürettiği binary'de
`LC_RPATH` yoktur. `src-tauri/.cargo/config.toml`'a girecek:

```toml
[target.'cfg(target_os = "macos")']
rustflags = ["-C", "link-arg=-Wl,-rpath,/usr/lib/swift"]
```

### 🔴 BULGU S4-b — `avassetwriter` crate'i macOS 26 SDK'sıyla derlenmiyor

İlk tasarım `videotoolbox` + `avassetwriter` zinciriydi. `avassetwriter 0.11.1`'in
Swift köprüsü, **bizim hiç kullanmadığımız altyazı kodunda** patlıyor:

```
Captions.swift:313: error: 'Position' is not a member type of
                    class 'AVFoundation.AVCaption.Ruby'
```

Üçüncü parti bir Swift köprüsüne bağlanmak, SDK'nın her yıl değişmesi karşısında
kırılgan. **Üretimde `objc2-av-foundation` ile doğrudan bağlanılacak** (Swift köprüsü yok,
objc2 SDK değişimlerini çok daha iyi taşıyor).

### 🟡 KARAR GEREKTİREN S4-d — asgari macOS sürümü

Aşama C, `SCRecordingOutput` ile ispatlandı; o **macOS 15.0+** ister.
Mevcut CopyBoard `MACOSX_DEPLOYMENT_TARGET = 11.0` ile derleniyor.

| Yol | Asgari macOS | İş | Not |
|---|---|---|---|
| `SCRecordingOutput` | **15.0** | ~sıfır — SCK encode+mux'u kendi yapar | Kalite/bitrate kontrolü sınırlı |
| SCStream + `objc2-av-foundation` (AVAssetWriter) | **12.3** | ~1,5 hafta | Bitrate, kalite kademeleri, ses karıştırma tam kontrol |
| Bugünkü Electron | 11.0 | — | ScreenCaptureKit zaten 12.3 ister; 11.0'da video hiç çalışmıyor olabilir |

**Öneri:** asgari **macOS 12.3** + `objc2-av-foundation` yolu. ScreenCaptureKit'in kendisi
zaten 12.3 istediği için 11.0 desteği bu özellik açısından zaten teoriktir.

---

## S6 — OCR ✅

`spikes/s6-ocr` · cmake 4.4.3 (resmi tarball, scratchpad'e açıldı, sistem değiştirilmedi)

```
gömülü diller       = ["tur", "eng"]
  eng.traineddata     14.7 MB
  tur.traineddata      7.1 MB
gömülü toplam       = 21.8 MB
TesseractAPI::new() = 0ms
init(tur+eng)       = 93ms          ← tesseract.js'te 1-2 sn worker warmup
tesseract sürümü    = 5.5.2
tanıma (2000x700)   = 1850ms
peak RSS            = 132 MB        ← tesseract.js worker'ı 150MB+
binary boyutu       = 25.6 MB       (tessdata gömülü dahil)
```

Gerçek ekran içeriğinde Türkçe aksanlar doğru çıktı:
*"Komut takibi tam"*, *"Komut önerisi desteklenmiyor"*, *"Oturum geri yüklendi"*.
Motor ve veri tesseract.js ile **aynı** olduğu için kalite paritesi yapısal olarak garanti.

### 🔴 BULGU S6-a — `embed-tessdata` varsayılan değil

`default = ["build-tesseract"]`. Gömme için feature açıkça açılmalı:
`features = ["build-tesseract", "embed-tessdata"]`.
Açıldığında `TESSERACT_EMBED_LANGUAGES` varsayılanı `"eng,tur"` — tam ihtiyacımız.

### 🔴 BULGU S6-b — `init_embedded()` tek dil alır

`EMBEDDED_TESSDATA` bir `HashMap<&str, &[u8]>`; `"tur+eng"` diye bir anahtar yok.
CopyBoard ise iki dili **birlikte** tanıyor (`createWorker('eng+tur')`).

**Çözüm:** gömülü blob'ları ilk çalıştırmada bir kez `app_data_dir/tessdata/`'ya yaz,
sonra normal çok dilli `init(dir, "tur+eng")` kullan. Paket hâlâ sıfır ek dosya taşır.

```rust
for lang in ["eng", "tur"] {
    let blob = tesseract_rs::get_embedded_tessdata(lang).unwrap();
    let f = dir.join(format!("{lang}.traineddata"));
    if !f.exists() { std::fs::write(&f, blob)?; }
}
api.init(&dir, "tur+eng")?;
```

### 🟡 BULGU S6-c — gömülü veri bugünkünden büyük

Şu an paketlenen: `eng` 5,2 MB + `tur` 4,7 MB = **9,9 MB** (`tessdata_fast` sürümleri).
tesseract-rs'in gömdüğü: **21,8 MB** (tam sürümler). Net fark **+11,9 MB**.

Tauri'nin ~18 MB'lık taban paketine eklenince macOS `.dmg` ~30 MB olur — hâlâ
Electron'un 120 MB'ının dörtte biri. İstenirse `TESSERACT_EMBED_LANGUAGES` ile
`tessdata_fast` sürümleri gömülerek bugünkü boyuta dönülebilir (doğruluk biraz düşer).

### ⚠ Ön koşul — cmake

`tesseract-rs`, Tesseract + Leptonica'yı kaynaktan derler; **cmake gerekir**.
GitHub Actions'ın macOS/Windows/Ubuntu imajlarında hazır gelir → CI etkilenmez.
Geliştirme makinesinde belgelenmeli. Bu makinede resmi cmake 4.4.3 tarball'ı
scratchpad'e açıldı; `CMAKE_POLICY_VERSION_MINIMUM=3.5` ortam değişkeni gerekti
(cmake 4.x eski `cmake_minimum_required` sürümlerini reddediyor).

---

## S5 — Kare akışı ✅

`spikes/s5-stream` · Gerçek ScreenCaptureKit kareleri → `Channel<InvokeResponseBody::Raw>` →
webview canvas. Altı senaryo × 5 saniye, release build.

| senaryo | kare/sn | MB/sn | kare | düşen | JS çizim | Rust dönüşüm | birikme | |
|---|---:|---:|---:|---:|---:|---:|---:|:--|
| 900×700 @1x ham RGBA | 14,7/15 | 35,8 | 2,4 MB | 0 % | 0,36 ms | 2,37 ms | −2 ms | ✅ |
| 900×700 @2x ham RGBA | 14,2/15 | **138,1** | 9,6 MB | 0 % | 1,08 ms | 8,07 ms | −3 ms | ✅ |
| 900×700 @2x JPEG q90 | 14,8/15 | 6,4 | 440 KB | 0 % | 0,12 ms | 23,66 ms | 0 ms | ✅ |
| 1280×800 @2x ham RGBA | 14,8/15 | **234,3** | 16 MB | 0 % | 1,47 ms | 11,35 ms | −7 ms | ✅ |
| 1280×800 @2x JPEG q90 | **8,9/15** | 6,3 | 706 KB | 0 % | 0,27 ms | **39,43 ms** | 0 ms | ❌ |
| 1280×800 @2x JPEG q90 30 fps | **13,1/30** | 9,2 | 708 KB | 0 % | 0,14 ms | **38,04 ms** | 0 ms | ❌ |

### 🟢 SONUÇ S5-a — `stitcher.js` JS'te KALIYOR

Plandaki en kötü senaryo (1280×800 @2x = 2560×1600, kare başına 16 MB) **234 MB/sn**
hızında, **sıfır kare düşümüyle**, birikme olmadan aktı. Plan §5.2'deki üç kademeli
yedek plan — kare hızını düşür → gri tonlamaya geç → stitcher'ı Rust'a portla —
**hiçbirine gerek yok**. 476 satırlık `stitcher.js` ve onun test dosyası olduğu gibi kalıyor.

`putImageData` maliyeti kare başına 0,36–1,47 ms; 15 fps'in 66 ms'lik bütçesinde yok hükmünde.

### 🔴 SONUÇ S5-b — Sıkıştırmak akışı YAVAŞLATIYOR

Sezgiye aykırı ama ölçüm net: JPEG, IPC trafiğini 234 MB/sn'den 6,3 MB/sn'ye —
**37 kat** — indiriyor, ve buna rağmen kare hızı 14,8'den **8,9'a düşüyor.**

Sebep IPC değil, **CPU**: 2560×1600 bir karenin BGRA→RGB dönüşümü + JPEG encode'u
Rust tarafında 39,4 ms sürüyor. 15 fps'in bütçesi 66 ms; encode tek başına bunun
%60'ını yiyor ve boru hattı aç kalıyor. 30 fps senaryosunda tavan 13,1 fps'te —
yani 38 ms'lik encode'un dayattığı ~26 fps sınırının altında.

**Kural: Tauri'nin ham byte IPC'si, sıkıştırmanın CPU maliyetinden ucuzdur.**
Bu boru hattında hiçbir yere kodlama koymayın.

### 🟢 KARAR S3-b — akışta ham RGBA, TEK KAREDE PNG

> **Düzeltme (Faz 3).** Bu karar önce "her yerde ham RGBA" diye yazılmıştı; bu, S5'in
> *akış* sonucunu tek-kare durumuna fazla genelleştirmekti. İki durumun cevabı farklı:

| Durum | Sıklık | Karar | Gerekçe |
|---|---|---|---|
| Kaydırmalı yakalama akışı | 15 kare/sn | **ham RGBA** | Encode 39 ms; 66 ms'lik bütçenin %60'ı. Sıkıştırmak kare hızını düşürüyor. |
| Ekran alıntısı / OCR / renk (tek kare) | bir kez | **PNG** | Encode 34 ms, bir defa, göze görünmez. IPC'de 32 MB yerine 3,6 MB taşıyor — PNG burada hem daha hızlı hem daha hafif. |

Tek karede PNG'nin ikinci bir kazancı: `snipper.js` görüntüyü zaten
`createImageBitmap(new Blob([data], { type: 'image/png' }))` ile çözüyor. PNG göndermek,
o dosyaya hiç dokunmamak demek.

### 🟡 BULGU S5-c — `impl Trait for Arc<T>` yetim kuralına takılıyor

`impl SCStreamOutputTrait for Arc<Streamer>` derlenmiyor: `Arc` yabancı bir tip ve
`Box`'ın aksine `#[fundamental]` değil. Paylaşılan durumu handler'a taşımak için
yerel bir newtype gerekiyor:

```rust
struct Handler(Arc<Streamer>);
impl SCStreamOutputTrait for Handler { /* self.0.… */ }
```

### 🟡 BULGU S5-d — Frontend release binary'ye GÖMÜLÜ

`cargo build` sırasında `generate_context!()` `frontendDist`'i binary'ye gömüyor.
HTML/CSS/JS değişikliği çalışan binary'ye yansımaz — **yeniden derlemek gerekir**.
Geliştirme sırasında `cargo tauri dev` kullanılmalı (o canlı sunar).
Bu, Electron'un `loadFile()` ile diskten okuma alışkanlığından farklı.

---

## ~~🚫 Bloke: S6 (OCR)~~ — çözüldü

`tesseract-rs`, Tesseract ve Leptonica'yı kaynaktan derler; bunun için **`cmake` gerekir.**
Bu makinede ne `cmake` ne de Homebrew kurulu.

```
$ which cmake brew
cmake not found
brew not found
```

**Bu bir plan bulgusudur, engel değil:** GitHub Actions'ın macOS/Windows/Ubuntu
imajlarının hepsinde `cmake` hazır gelir, yani CI etkilenmez. Yalnız **geliştirme
makinesinde bir ön koşul** olarak belgelenmeli.

Seçenekler:
1. Homebrew + `brew install cmake` (makineyi kalıcı değiştirir)
2. cmake.org'un resmi macOS universal `.tar.gz`'i (kurulum gerektirmez, tek dizin)
3. S6'yı atlayıp yedek plana geçmek: gizli bir webview'da `tesseract.js` (§5.9)

---

---

## Faz 1 sırasında çıkan bulgular

Faz 0 spike'ları bittikten sonra, gerçek uygulama kodunu yazarken çıkan ve
spike'ların yakalayamadığı davranışlar.

### 🔴 BULGU F1-a — Gizli pencereye `set_position` macOS'ta sessizce kayboluyor

Toast penceresi `visible: false` kurulup konumlandırılıyor, sonra `show()` ediliyordu.
Sonuç: pencere macOS'un varsayılan cascade konumunda açıldı, verilen koordinat yok
sayıldı — **ve hiçbir hata dönmedi** (`set_position` `Ok(())` verdi).

```text
istenen : (2248, -1360)
gerçek  : (740, 283)      ← macOS cascade
```

**Kural: önce `show()`, sonra `set_position`.** Pencere şeffaf ve içeriği (toast kartı)
`show` sınıfı eklenene dek `translateX` ile ekran dışında park ettiği için, bu sıradaki
tek karelik yerleşim titremesi kullanıcıya görünmüyor.

### 🔴 BULGU F1-b — `PhysicalPosition` macOS'ta değeri ölçek kadar BÖLÜYOR

F1-a düzeltildikten sonra pencere hâlâ yanlış yerdeydi. Sebep daha ince:

macOS'un global pencere koordinat uzayı **nokta (mantıksal)** cinsindendir ve
monitörler arasında **tek biçimlidir** — 2x bir ekranın yanındaki 1x ekran aynı nokta
ızgarasında yaşar. tao ise `Position`'ı platforma vermeden önce **pencerenin O ANKİ
ölçeğiyle** mantıksala çevirir.

Toast penceresi 2x dahili ekranda doğuyor, hedefi 1x harici ekran:

```text
set_position(PhysicalPosition(2248, -1360))  →  pencere (1124, -680)'de
                                                 tam olarak yarısı
set_position(LogicalPosition(2248, -1360))   →  pencere (2248, -1360)'ta  ✅
```

**Kural: pencere yerleşiminde `Logical*` kullan, `Physical*` DEĞİL.**
Fiziksel piksel yalnız ekran YAKALAMA çağrılarında gerekli.

> Bu ikisi birlikte, planın §5.7'sinde uyardığım tuzağın ta kendisi — ve uyarıyı
> yazan kişi olarak yine de düştüm. `geom.rs` artık tek geçit: monitör verisi
> okunur okunmaz noktaya çevriliyor, `place()` yalnız `Logical*` kullanıyor,
> ve iki kural da doc yorumunda ölçümleriyle duruyor.

### 🔴 BULGU F1-c — `listen()` bir promise; beklemeden "hazırım" demek olayı düşürüyor

`api-tauri.js`'te toast penceresi dinleyicisini kurup hemen `toast_ready` bildiriyordu.
`listen()` asenkron olduğu için ana süreç `display-toast`'ı dinleyici kurulmadan
yayınlayabiliyor ve mesaj sessizce düşüyor.

```js
// YANLIŞ
onSpread('display-toast', cb);
send('toast_ready');

// DOĞRU
onSpread('display-toast', cb).then(() => send('toast_ready'));
```

Electron'da `ipcRenderer.on` senkrondu ve bu sınıf hata yoktu. Aynı kalıp `onCaptureScreen`,
`onViewerImage`, `onQuickPasteShow` gibi "pencere hazır olunca veri gönder" akışlarının
hepsinde geçerli — Faz 3-5'te tekrar edecek.

### 🟡 BULGU F1-d — `log` crate'i implementasyonsuz sessizce yutuyor

İlk çalıştırmada pencere görünmedi ve **hiç log çıkmadı**: `log::info!` çağrıları bir
implementasyon kurulmadan hiçbir yere gitmiyor. `tauri-plugin-log` eklenene kadar
hata ayıklama körlemesineydi. Projede ilk kurulan şeylerden biri olmalı.

### 🔴 BULGU F3-a — `connect-src`'siz CSP TÜM IPC'yi sessizce JSON'a düşürüyor

Yakalama karesi renderer'a **5.356.348 elemanlı düz bir JS `Array`** olarak ulaştı,
`ArrayBuffer` olarak değil. `snipper.js` `imageData.byteLength`'e baktığı için görüntüyü
"boş" sayıp kendi kendini onarma döngüsüne girdi.

Sebep, Tauri'nin IPC'sinin iki yolu olması:

```js
// tauri/scripts/ipc-protocol.js
fetch(convertFileSrc(cmd, 'ipc'), { method: 'POST', body: data, headers })
  .then(r => r.arrayBuffer())          // ← ham bayt
  .catch(() => {
     console.warn('IPC custom protocol failed, Tauri will now use the postMessage interface instead')
     customProtocolIpcFailed = true
     sendIpcMessage(message)            // ← her şey JSON
  })
```

`tauri.conf.json`'daki CSP'de **`connect-src` yoktu**, yani `default-src 'self'`'e düşüyor
ve macOS'ta `ipc://localhost`'a yapılan `fetch` engelleniyordu. Tauri de sessizce
postMessage'a geçiyordu.

**Bunun sinsiliği: her şey ÇALIŞMAYA DEVAM EDİYOR.** `get_history`, `get_settings`,
tema, dil — hepsi JSON zaten. Yalnız ham bayt taşıyan yollar bozuluyor, ve onlar da
"bozuk" değil sadece felaket derecede verimsiz oluyor. Faz 4'ün 15 fps'lik kaydırma
akışını (Spike-5'te 234 MB/sn ölçülmüştü) tamamen yok ederdi ve sebebi görünmezdi.

**Çözüm** — `tauri.conf.json` VE her sayfanın `<meta>` CSP'sinde:

```
connect-src ipc: http://ipc.localhost asset: http://asset.localhost;
```

> Spike-5'te bu çıkmamıştı çünkü o spike `"csp": null` ile çalışıyordu. Spike'lar
> minimal kurulumla koşar; üretim yapılandırmasının kendi tuzakları var.

### 🟡 BULGU F3-b — Renderer konsolu hiçbir yere bakmıyordu

Yukarıdaki hatayı bulmayı sağlayan tek şey, `console.warn`/`error` ve yakalanmamış
hataları `debug_log` komutuna yönlendirmek oldu. Paketlenmiş bir uygulamada webview
konsolu görünmez; bu yönlendirme kalıcı hâle getirildi ve artık `copyboard.log`'a
düşüyor — kullanıcıda çıkan bir sorunda isteyecek bir şey var.

### 🔴 BULGU F5-a — Güncelleyici eklentisi yapılandırma yoksa UYGULAMAYI AÇTIRMIYOR

`tauri-plugin-updater` kaydedilip `tauri.conf.json`'da `plugins.updater` bölümü
verilmezse uygulama açılışta panikliyor:

```
PluginInitialization("updater", "Error deserializing 'plugins.updater' within your
Tauri configuration: invalid type: null, expected struct Config")
```

Yani imza anahtarı henüz üretilmemiş bir projede uygulama HİÇ çalışmıyor. Çözüm:
bölümü boş `pubkey` ile eklemek. Eklenti yükleniyor, `check()` imza doğrulayamadığı
için temiz bir hata veriyor, uygulama açılıyor. Anahtar üretildiğinde yalnız `pubkey`
doldurulacak.

### 🔴 BULGU F5-b — "Hazırım" el sıkışması GENEL bir kural

F1-c (toast) tek bir örnek değilmiş. Aynı yarış üç ayrı yerde çıktı:

| Nerede | Belirti |
|---|---|
| Toast | pencere görünür, mesaj yok |
| Görüntüleyici | araç çubuğu var, **görüntü alanı boş** |
| Güncelleme diyaloğu | sürüm bilgisi gelmiyor |

Electron'da `ipcRenderer.on` senkrondu; ana süreç `did-finish-load`'da veri
itebiliyordu. Tauri'de `listen()` bir promise ve dinleyici ancak o çözülünce kuruluyor.

Tek tek yamamak yerine genel bir el sıkışma yapıldı: renderer dinleyicilerini kurar,
sonra `window_ready` çağırır, ana süreç ilk durumu ancak o zaman gönderir
(`commands/ready.rs`).

> Yakalama overlay'i bu hatayı hiç yaşamadı, çünkü kareyi İTİLMEYİ beklemek yerine
> kendisi ÇEKİYOR. Çekme modeli bu yarışa yapısal olarak bağışık.

### 🔴 BULGU F5-d — `setIgnoreMouseEvents(true, { forward: true })` karşılığı YOK; widget tıklanamaz kalıyordu

**Belirti:** Widget ekranda görünüyor ama hiçbir tıklama almıyor.

**Sebep:** Electron `setIgnoreMouseEvents(true, { forward: true })` sunuyordu — pencere
tıklama-geçirgen oluyor AMA `mousemove` olaylarını almaya DEVAM ediyordu. Widget'ın tüm
etkileşim modeli buna dayanıyordu:

```js
// widget.js (Electron)
refreshIgnore() {
    if (isOverInteractive(lastMouseX, lastMouseY)) setIgnore(false);   // yakala
    else setIgnore(true, { forward: true });                            // geçir AMA hareketi gör
}
document.addEventListener('mousemove', (e) => { …; refreshIgnore(); });
```

Tauri'nin `set_ignore_cursor_events(bool)`'unda `forward` parametresi yok ve macOS'ta
`ignoresMouseEvents = YES` **mousemove'u da kesiyor.** Sonuç: pencere geçirgen
başlıyor → hiç olay almıyor → `refreshIgnore` bir daha hiç çalışmıyor → **kalıcı olarak
tıklanamaz.**

> Planın §5.5'inde bu riski Windows için öngörmüştüm ve "macOS'ta zaten varsayılan"
> yazmıştım. Yanlıştı: macOS'ta da geçerli, ve orada belirti daha sert çünkü widget
> etkileşiminin TAMAMI o iletilen hareketlere bağlı.

**Çözüm:** Karar renderer'dan ana sürece taşındı.

| | Önce (Electron) | Sonra (Tauri) |
|---|---|---|
| İmleç konumu | webview'a iletilen mousemove | Rust'ta 30 ms'lik `cursor_position()` yoklaması |
| Hit-test | `isOverInteractive()` (JS) | `HitArea::contains()` (Rust) |
| Geometri | JS'te hesaplanıp JS'te kullanılıyor | JS hesaplıyor, `set_widget_hit_areas` ile bildiriyor |
| Geçirgenlik | JS karar veriyor | Rust karar veriyor |

Kullanıcıya görünen davranış birebir aynı: yuvarlak düğmeler ve açık panel tıklanabilir,
aradaki saydam boşluklar alttaki uygulamaya geçiyor.

**Ölçüm:**
```
açılış                        → AÇIK (geçirgen)
imleç düğme merkezinde        → KAPALI (tıklanabilir)
imleç uzakta                  → AÇIK (geçirgen)
```

**Aynı sorun kaydedicide de var** (`recorder.js` araç çubuğu üzerinde `forward:true`
kullanıyordu). Orada da aynı yaklaşım gerekiyor — bkz. açık kalemler.

### 🟡 BULGU F5-c — "Hata yok" araması çökmeyi kaçırdı

Faz 5 doğrulamasında logda hata aradım, bulamadım, "çalışıyor" dedim. Oysa uygulama
açılışta panikleyip ölüyordu; arama desenim panik metnini kapsamıyordu. Ekranda
gördüğümü sandığım widget de başka bir şeydi.

**Kural: bir çalıştırmayı doğrularken önce SÜRECİN AYAKTA olduğuna bak.** Doğrulama
komutlarına `pgrep` kontrolü eklendi.

### 🟡 BULGU F1-e — `frontendDist` dışındaki varlıklar sunulmuyor

`index.html`, uygulama ikonunu `../../../icon.png` ile depo kökünden çekiyordu.
Tauri yalnız `frontendDist` (`src/renderer`) altını sunar; ikon 404 verdi.
İkon `src/renderer/shared/` içine alındı — bu yol Electron'un `loadFile`'ında da
aynı şekilde çözülüyor, yani iki sürüm de çalışıyor.

---

## Sırada

| # | İş | Not |
|---|---|---|
| S9–S11 | Linux X11 / Wayland / WebKitGTK | Linux VM / makine gerekiyor |
| **Karar** | Asgari macOS sürümü (§S4-d) | 12.3 + objc2-av-foundation önerilir |

**macOS/Windows çekirdeği için Faz 0 TAMAMLANDI.** Yedi spike, yedi geçiş, dokuz bulgu.
Faz 1'e (iskelet + pencere altyapısı) geçilebilir.

---

## Cerrahi gözden geçirme — bulgular ve düzeltmeler

Faz 6 sonunda tüm port, Electron kaynağıyla satır satır karşılaştırıldı. Aşağıdakiler
DÜZELTİLDİ; her biri ya Electron'da açıkça çözülmüş bir davranışın portta kaybolması,
ya da Tauri'nin Electron'dan sessizce ayrıldığı bir nokta.

### 🔴 BULGU R-1 — Dil değişimi hiç çalışmıyordu

`set_language` ayarı yazıp pencereleri `location.reload()` ediyordu. Ama sözlük
`initialization_script` ile enjekte ediliyor ve o script **yeniden yüklemede de
ESKİ yükün kopyasıyla** çalışıyor — pencere Türkçe geri geliyordu.

Düzeltme: `set_language` taze yükü `sessionStorage`'a yazıp sonra reload ediyor;
`boot_script` varsa `sessionStorage`'ı tercih ediyor.

Ampirik doğrulama (`--set-lang=en`, üç pencere):

```
[DIL] lang=tr Kaydet=null      ×3     ← önce
[DIL] lang=en Kaydet="Save"    ×3     ← sonra
```

### 🔴 BULGU R-2 — Monitör değişimi izlenmiyordu

`widget::handle_display_change` YAZILMIŞ ama HİÇ ÇAĞRILMIYORDU. Electron
`screen.on('display-added'|'display-removed'|'display-metrics-changed')` dinliyordu.
Sonuç: harici ekran çıkarılınca widget artık var olmayan koordinatlarda kalıyor,
görünmez ve tıklanamaz oluyordu — kurtuluşu yalnız yeniden başlatmaktı.

Tauri'de olay karşılığı yok (macOS'ta `NSApplicationDidChangeScreenParameters` için
Objective-C sınıfı tanımlamak gerekir). 3 sn'de bir monitör parmak izi karşılaştırması
kuruldu; ayrıca 500/2000/5000 ms üçlü senkron artık **nesil sayacıyla iptal edilebilir**
(Electron birikmiş timeout'ları iptal ediyordu, port etmiyordu).

### 🟠 BULGU R-3 — Kaydetme paneli görünmüyordu

`commands/capture.rs`'teki kaydetme paneli **parent'sız** açılıyor ve always-on-top
yakalama overlay'i indirilmiyordu. Electron'da bu, ölçümle bulunmuş bir hatanın
düzeltmesiydi: overlay uygulamayı ön plana almadığı için panel öndeki BAŞKA uygulamanın
arkasında açılıyordu. `set_parent` + overlay'i indir/geri kaldır eklendi; eksik
`title` de kondu.

### 🟠 BULGU R-4 — Eşik UTF-8 baytı sayıyordu

`MAX_ITEM_CHARS` Electron'da `content.length` yani **UTF-16 kod birimi**ydi.
`str::len()` ise **bayt** sayıyor: Türkçe harf 2, CJK 3, emoji 4 bayt. Tam Türkçe bir
metinde eşik fiilen YARIYA iniyor ve Electron'da rahatça geçen bir kayıt Tauri'de
sessizce reddediliyordu. `utf16_len()` eklendi; regresyon testi kondu.

### 🟠 BULGU R-5 — Oku-değiştir-yaz yarışı veri düşürüyordu

`store.get()` ve `store.set()` kilidi AYRI alıyor. `get → değiştir → set` kalıbında
araya giren bir yazma kayboluyordu — geçmiş, favoriler ve galeri, hepsi bu kalıptaydı.

Atomik `Store::update()` eklendi. Testle ölçüldü (8 thread × 50 ekleme):

| Kalıp | Hayatta kalan |
|---|---|
| `get` + `set` | **395 / 400** |
| `update` | **400 / 400** |

### 🟠 BULGU R-6 — OCR sonucu ana thread dışından panoya yazılıyordu

BULGU S1-a'nın (NSPasteboard ana thread kuralı) ihlali: `spawn_blocking`den dönen
async komut worker thread'de çalışıyordu. `run_on_main_thread`e alındı.

### 🟠 BULGU R-7 — Uyku / ekran kilidi hiç ele alınmıyordu

Electron `powerMonitor.on('suspend'|'lock-screen')` ile pano yoklamasını durduruyor ve
**bekleyen yazmaları diske boşaltıyordu** ("sleep can outlive its 500ms window").
Portta hiçbiri yoktu: uyanmadan kapanan bir makinede son kopyalanan içerik kayboluyordu.

`platform/macos/power.rs` eklendi — uyku `NSWorkspace`in bildirim merkezinden, ekran
kilidi `NSDistributedNotificationCenter`den (iki AYRI merkez).

### 🟠 BULGU R-8 — Küçük resim yükseltmesi yazılmamıştı

Electron açılışta `upgradeThumbnails()` çağırıyordu. Portta yoktu: v2'den göç eden
HER kullanıcının galerisi bulanık kalıyordu. Ölçüt Electron'unkiyle aynı — bir girdi
kendi boyutlarının hak ettiğinden küçük küçük resim taşıyorsa yenileniyor, yani
orijinali zaten küçük olan girdi her açılışta boşuna işlenmiyor.

### 🟡 BULGU R-9 — Yakalama overlay'inde yükleme yarışı

Overlay'ler yakalamayla PARALEL açılıyor, yani `capture-screen` olayı pencere sayfası
yüklenmeden yayınlanabiliyordu — o durumda olay sessizce düşer ve overlay donuk bir
karartmadan ibaret kalır. Electron'da bu yarış YOKTU (`did-finish-load` bekleniyordu).
Ölçülen marj ~100 ms; 3 denemede tekrarlanmadı ama makine yüklüyken ters dönecek kadar
dar. Genel `window_ready` el sıkışmasına bağlandı (BULGU F1-c'nin aynı ailesi);
`quickpaste-show` da aynı sebeple bağlandı.

### 🟡 BULGU R-10 — Tepsi menüsü numpad tuş ipuçlarını kaybediyordu

Tepsi accelerator'ları `muda` ile ayrıştırılıyor. muda `numadd`i tanıyor ama diğer dört
numpad işlecinde Electron'dan AYRILIYOR — uzun ad istiyor:

| Ayarlarda saklanan | muda'nın istediği |
|---|---|
| `numsub`  | `NumSubtract` |
| `nummult` | `NumMultiply` |
| `numdiv`  | `NumDivide`   |
| `numdec`  | `NumDecimal`  |

Çeviri eklendi. Test elle tutulan bir listeyle değil, **muda'nın kendi ayrıştırıcısıyla**
doğruluyor (dev-dependency) — muda sürüm atlayınca test kırılır, üretimde menü sessizce
accelerator'ını kaybetmez.

### 🟡 BULGU R-11 — `theme: 'system'` OS'u izlemiyordu

Electron'da `nativeTheme.on('updated')` vardı. Pencere başına `ThemeChanged` olayına
bağlandı. (Tauri'de `on_window_event` dinleyicileri **birikiyor**, birbirini ezmiyor —
`AddEventListener` benzersiz id ile kaydediyor; kontrol edildi.)

### 🟡 BULGU R-12 — Widget yerleşim monitörü unutuluyordu

Electron `widgetDockParams.displayId` ile widget'ın yerleştiği FİZİKSEL ekranı
hatırlıyordu; portta bu alan göç sırasında düşürülüyor ve yerine konmuyordu. Tauri'de
sayısal ekran kimliği yok, **ad** var (`Monitor::name()`); `displayName` olarak
saklanıyor ve Electron'un seçim sırası birebir kuruldu: kayıtlı konumu İÇEREN monitör →
kayıtlı ekran adı → en yakın → birincil.

### 🟡 BULGU R-13 — İsabet testi boşta da yokluyordu

Electron'da yoklama YOKTU (OS `mousemove` itiyordu). Port 30 ms'de bir sonsuza dek
uyanıyordu. İki kademeli düzeltme: kayıt boşken thread **condvar'da uyuyor**; imleç
kıpırdamadığında pencere sunucusu sorguları atlanıyor (en fazla 10 tur, sonra tam
kontrol — imleç sabitken PENCERE hareket edebilir). Ölçüm: boşta **%0,0 CPU**.

### 🟡 BULGU R-14 — Açılıştaki pano içeriği

Electron her açılışta panodaki içeriği geçmişe ekliyordu; yan etkisi, bir saat önce
kopyalanan şeyin her açılışta listenin başına atlamasıydı. Port bunu tamamen yok
sayıyordu; yan etkisi, kullanıcı bir şey kopyalayıp SONRA CopyBoard'u açtıysa o içeriğin
hiç yakalanmamasıydı. **İkisi de değil:** sayaç tohumlanıyor (tekrar tekrar başa
taşınmıyor) ama içerik geçmişte hiç yoksa bir kez ekleniyor.

### 🟡 BULGU R-15 — Ölü komutlar

`toast_ready` ve `update_dialog_ready` komut olarak açıktı ama renderer'da **sıfır**
çağrısı vardı (el sıkışma `window_ready` üzerinden yürüyor). IPC yüzeyinden kaldırıldı.

---

### Doğrulama

| Kontrol | Sonuç |
|---|---|
| `cargo test --lib` | **72 geçti**, 0 başarısız |
| `npm test` | **52 geçti**, 0 başarısız |
| Hata ayıklama çalıştırması | ayakta, panik yok, boşta %0,0 CPU |
| Sürüm çalıştırması | ayakta, 100 MB RSS, uyarı/hata yok |
| Sürüm binary'sinde `--capture=`/`--viewer`/`--record-test`/`--set-lang=` | **yok** (hepsi `debug_assertions` arkasında) |

---

### 🔴 BULGU R-16 — Video durdurma her seferinde 5,5 sn boşa bekliyordu

Kullanıcı bildirdi: Electron sürümünde "Durdur" deyince kaydetme paneli hemen
geliyordu; Tauri'de "Video hazırlanıyor…" yazıp uzun sürüyordu.

`Recording::stop()` yalnız `stream.stop_capture()` çağırıyordu. O çağrı kare akışını
kesiyor ama **kayıt çıktısını kapatmıyor** ve `on_finish` delegate'ini tetiklemiyor.
Kütüphanenin belgelediği kapatma sırası iki adımlı:

```rust
stream.stop_capture()?;
stream.remove_recording_output(&recording)?;   // ← bu eksikti
```

İkincisi kendi tamamlanma geri çağrısını bekliyor — mux'un gerçekten kapandığı an
orası. Eksikken `finished` bayrağı hiç `true` olmuyor ve emniyet döngüsü her
durdurmada 5 sn'lik zaman aşımını sonuna kadar bekliyordu. Üstüne koşulsuz 300 ms
uyku vardı.

Ölçüm (15 sn'lik kayıt, sistem sesiyle):

| | `stop_capture` | mux | **toplam** | `finished` |
|---|---|---|---|---|
| Önce | 18,5 ms | 5,19 s | **5,51 s** | `false` |
| Sonra | 8,3 ms | 6,3 ms | **14,5 ms** | `true` |

**380× hızlandı.** Bekleme tamamen boşunaydı: dosya çoktan hazırdı.

Yan bulgu: emniyet döngüsünün adımı 100 ms'ti, yani bayrak hemen otursa bile ölçüm
hep 100 ms çıkıyordu. Adım 5 ms'ye indirildi (tavan yine 5 sn).

Çıktı doğrulandı — mp4 başlığı elle ayrıştırıldı: süre 10,05 sn (10 sn'lik kayıt),
`vide` + `soun` izleri yerinde, `ftyp`/`mdat`/`moov` yapısı tam.

> Windows'un durdurma yolu ayrı (`MfWriter`, Media Foundation) ve bu düzeltmeden
> etkilenmiyor; orada ayrıca sınanması gerekir.

### 🟠 BULGU R-17 — Kayıt her kademede 30 fps'ti, arayüz 60 vaat ediyordu

Kullanıcı "görüntü kalitesi düşük gibi" dedi. Kaynak tek değil; Electron'un kalite
kademesi ÜÇ şeyi birden ayarlıyordu, port yalnız birini:

| Kademe | Electron fps | Electron bit hızı | Port (önce) | Port (şimdi) |
|---|---|---|---|---|
| ultra  | 60 | 50 Mbps | 30 fps, ölçek 1.0 | **60 fps**, ölçek 1.0 |
| high   | 60 | 25 Mbps | 30 fps, ölçek 1.0 | **60 fps**, ölçek 1.0 |
| medium | 30 | 10 Mbps | 30 fps, ölçek 0.75 | 30 fps, ölçek 0.75 |
| low    | 30 |  5 Mbps | 30 fps, ölçek 0.5  | 30 fps, ölçek 0.5 |

`with_fps(30)` sabitlenmişti; arayüz ise açıkça "Yüksek (60fps)" ve "Ultra (60fps)"
yazıyor. Hareketli içerikte 30 ile 60 arasındaki fark bariz. **Düzeltildi.**

Ayrıca `ultra` ile `high` portta BİRBİRİNİN AYNIYDI (ikisi de ölçek 1.0, 30 fps) —
kullanıcı "Ultra" seçtiğinde hiçbir şey değişmiyordu. Artık ikisi de 60 fps; aradaki
fark yine de bit hızı olmadan tam kurulamıyor (aşağıya bakın).

### ⚠ AÇIK — Bit hızı ayarlanamıyor (`SCRecordingOutput` sınırı)

Electron `videoBitsPerSecond` veriyordu (high = 25 Mbps). `SCRecordingOutputConfiguration`
yalnız ÜÇ şey sunuyor — çıktı URL'i, kodek (H.264/HEVC) ve dosya türü. Bit hızı yok;
Apple'ın varsayılanına kalıyoruz ve o 25 Mbps değil.

Bunu düzeltmek `SCRecordingOutput`u bırakıp **`AVAssetWriter`** yoluna geçmeyi
gerektiriyor: kareleri `SCStreamOutput` ile kendimiz alıp `AVVideoAverageBitRateKey`
ile yazmak (plan §5.1). `objc2-av-foundation` 0.3.2 bunu sağlıyor — daha önce
derlenemeyen `avassetwriter` crate'i (Swift köprüsü, macOS 26 SDK'sında düşüyordu)
DEĞİL. Kapsam küçük değil: kare/ses zamanlaması, oturum yönetimi ve sonlandırma
elle yazılacak.

> Kare hızının dosyaya yansıdığı ÖLÇÜLEMEDİ: ölçüm sırasında makinenin ekranı
> uykuya geçti ve `available_monitors()` boş dönüyor. Eşleme birim testiyle
> korunuyor (`kalite_kademesi_kare_hizina_donusuyor`), ama gerçek kayıtta
> doğrulanması gerekiyor.

### 🟡 BULGU R-18 — Durdurmadan sonra ekran bir an tamamen boş kalıyordu

"Video hazırlanıyor…" yazısı, kaydetme paneli İSTENMEDEN 48 satır önce siliniyordu.
Panelin belirmesi gözle görülür sürebildiği için arada ekranda hiçbir şey kalmıyor ve
kullanıcı "durdura bastım, bir şey olmadı" deyip tekrar basıyordu. Yazı artık
silinmiyor, "Kaydetme penceresi açılıyor…" olarak kalıyor — panel başka monitörde
açıldıysa nereye bakacağını da söylüyor.

İkinci basış zaten zararsızdı (`RecorderState` `take()` ile boşaltılıyor), ama
kullanıcı bunu bilemezdi.
