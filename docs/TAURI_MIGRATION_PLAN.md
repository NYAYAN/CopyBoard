# CopyBoard → Tauri v2 Göç Planı

> Sürüm: 1.0 · Tarih: 2026-08-30 · Kaynak sürüm: CopyBoard v2.12.0 (Electron 39)
> Hedef: Electron'un tamamen kaldırılması, uygulamanın Tauri v2 (Rust + sistem WebView) üzerinde birebir çalışması.
> Platformlar: **macOS + Windows + Linux** (Linux yeni — kısıtları §5.14'te)
>
> **Alınan kararlar:** K2 = yerel Rust encoder · K7 = Linux kapsama dahil · Başlangıç = Faz 0 spike'ları

---

## 1. Yönetici Özeti

**Verdict: Yapılabilir, ama bu bir "framework değişimi" değil, ana sürecin (main process) sıfırdan yeniden yazımıdır.**

| Katman | Satır | Göç durumu |
|---|---:|---|
| `src/renderer/**/*.js` | 7.737 | **%90+ aynen korunur** (2 dosya hariç) |
| `src/renderer/**/*.css` | 5.235 | **Aynen korunur** (3 küçük düzeltme) |
| `src/renderer/**/*.html` | 1.420 | **Aynen korunur** (CSP + drag-region düzeltmesi) |
| `src/preload/preload.js` | 131 | **Yeniden yazılır** → `api-tauri.js` shim |
| `src/main/**/*.js` | 3.704 | **Tamamı Rust'a yeniden yazılır** (~7–9k satır Rust) |
| `native/mac-hotkey/*.mm` | 159 | **Rust FFI'ya taşınır** (node-gyp tamamen kalkar) |

Kritik nokta: uygulamanın değeri renderer'da değil, **ana süreçteki 3.704 satırlık, yıllarca hata ayıklanmış platform davranışında** (çok monitörlü yakalama, pencere seviyeleri, macOS Spaces, tıklama geçirgenliği, kısayol askıya alma, TCC izinleri). Bu kodun her satırı Rust'ta yeniden üretilmek zorunda.

**En büyük 3 risk — sırayla:**

1. **Video kaydı ve Kaydırmalı Yakalama.** Her ikisi de Chromium'a özgü `getUserMedia({ chromeMediaSource: 'desktop' })` üzerine kurulu. macOS'ta Tauri WKWebView kullanır; WKWebView'da **ne `getDisplayMedia` ne de `chromeMediaSource` vardır**. Bu iki özellik web tarafında kurtarılamaz, Rust'ta yeniden yazılmalıdır.
2. **OCR.** `tesseract.js` Node worker_threads üzerinde ana süreçte çalışıyor; Tauri'de Node yok. Rust tarafına (`tesseract-rs`) taşınacak.
3. **Senkron preload.** `window.api.i18n` ve `window.api.theme` sayfa scriptleri çalışmadan **önce** `sendSync` ile dolduruluyor. Tauri'de senkron IPC yok; `initialization_script` ile çözülür (çözümü var, ama her pencerede tekrarlanır).

**Efor tahmini (tek geliştirici, tam zamanlı):**

| Faz | İş | Süre |
|---|---|---:|
| 0 | Doğrulama spike'ları (git/kalsın kararı) | 1,5 hafta |
| 1 | İskelet + pencere yönetimi + IPC köprüsü | 1,5 hafta |
| 2 | Pano, store, tepsi, kısayollar, tema/dil | 2 hafta |
| 3 | Ekran alıntısı + OCR + renk seçici | 2 hafta |
| 4 | **Video kaydı + kaydırmalı yakalama** | 4–5 hafta |
| 5 | Galeri, görüntüleyici, widget, hızlı yapıştır, güncelleyici | 2 hafta |
| 6 | Paketleme, imzalama, CI, veri göçü | 2 hafta |
| 7 | Beta, hata kapatma, geçiş | 2,5 hafta |
| L | **Linux uyarlaması** (fazlara serpiştirilmiş) | +4 hafta |
| | **Toplam** | **~20–22 hafta** |

**Kazanımlar (neden yapmaya değer):**

- Kurulum boyutu: **305 MB → 36 MB** (macOS `.app`) — ölçüldü
- Boşta RAM: **670 MB → 252 MB** — ölçüldü (aşağıdaki nota bakın)
- `node-gyp` / `postinstall` derleme adımı tamamen kalkar (kullanıcıda derleyici gerekmez)
- macOS'ta sistem sesi kaydı **BlackHole gerekmeden** çalışabilir (ScreenCaptureKit yerleşik ses yakalar)
- Hızlı yapıştırma macOS'ta **Automation (Apple Events) izni gerektirmez** — `CGEventPost` yalnızca Erişilebilirlik ister; bugünkü `-1743` hata sınıfı tamamen yok olur
- Chromium yerine sistem WebView: güvenlik yamaları OS ile gelir

**Kayıplar / geriye gidişler (kabul edilmesi gerekenler):**

- Video çıktısı `.webm` (VP8/VP9) → **`.mp4` (H.264)** olur. macOS/Windows yerel encoder'lar WebM üretmez. (Aslında uyumluluk açısından iyileşme, ama format değişikliği sürüm notlarına yazılmalı.)
- WKWebView, Chromium'dan farklı render eder: `backdrop-filter`, `-webkit-scrollbar` ve `<input type=range>` stilleri tek tek doğrulanmalı.
- Windows'ta WebView2 runtime'ının kurulu olması gerekir (Win10 1803+ çoğu makinede zaten var; bootstrapper Tauri kurulumuna gömülebilir).
- Tek bir Chromium sürümü yerine **üç** farklı motor (WKWebView + WebView2 + WebKitGTK) test edilir.
- **Linux'ta Wayland altında uygulama bugünkü davranışını tam veremez** — bkz. §5.14. Bu bir uygulama hatası değil, Wayland'ın güvenlik modelinin sonucudur.

---

## 2. Mevcut Durum Envanteri

### 2.1 Electron API yüzeyi

```
ipcRenderer.*   99 çağrı      ipcMain.*        87 kayıt
webContents.*   84 çağrı      app.*            39 çağrı
screen.*        37 çağrı      clipboard.*      22 çağrı
dialog.*        16 çağrı      autoUpdater.*    12 çağrı
BrowserWindow.* 12 çağrı      globalShortcut.*  9 çağrı
nativeImage.*    8 çağrı      shell.*           5 çağrı
systemPreferences.* 4        powerMonitor.*    4 çağrı
Menu.* 3   desktopCapturer.* 2   session.* 1   contextBridge.* 1
```

### 2.2 IPC kanalları (toplam 97)

**Renderer → Main (78 kanal)** — `invoke` (6 adet, cevap döner) + `send` (72 adet, tek yön):

| Grup | Kanallar |
|---|---|
| Çekirdek | `get-history`, `get-settings`, `close-window`, `minimize-window`, `debug-log`, `toast-finished`, `toast-resize` |
| Tema/Dil | `i18n-get`*, `set-language`, `theme-get`*, `set-theme` |
| Pano | `copy-item`, `copy-text`, `delete-history-item`, `clear-history`, `add-to-favorites`, `remove-from-favorites`, `set-item-note`, `reorder-history`, `reorder-favorites`, `set-max-items`, `set-clipboard-paused` |
| Kısayol | `set-shortcut`, `set-image-shortcut`, `set-video-shortcut`, `set-ocr-shortcut`, `set-color-shortcut`, `set-scroll-shortcut`, `set-paste-shortcut`, `set-shortcut-enabled` |
| Yakalama | `snip-ready`, `snip-close`, `snip-copy-v2`, `snip-copy-color`, `snip-save-image`, `snip-copy-buffer`, `snip-save-buffer`, `capture-retry`, `capture-claim-monitor`, `set-ignore-mouse-events` |
| OCR | `ocr-process` |
| Video | `record-start`, `record-chunk`, `record-stop`, `set-video-quality`, `set-audio-mic`, `set-audio-system`, `get-audio-settings`, `ensure-mic-permission` |
| Kaydırma | `scroll-begin`, `scroll-end` |
| Galeri | `get-screenshots`, `copy-screenshot`, `delete-screenshot`, `show-screenshot-file`, `open-screenshot-folder`, `screenshot-context-menu` |
| Görüntüleyici | `open-screenshot-viewer`, `viewer-nav`, `viewer-select`, `viewer-close`, `viewer-minimize`, `viewer-toggle-maximize`, `viewer-copy-annotated`, `viewer-compare-images` |
| Widget | `widget-action`, `set-show-widget`, `set-widget-transparent`, `set-widget-color`, `set-widget-opacity`, `set-widget-scale` |
| Hızlı Yapıştır | `quickpaste-pick`, `quickpaste-dismiss`, `set-quickpaste-count` |
| Güncelleme | `check-for-updates`, `download-update`, `install-update`, `open-url` |
| Diğer | `set-autostart` |

`*` = **senkron** (`sendSync`) — Tauri'de karşılığı yok, bkz. §5.3.

**Main → Renderer (19 olay):**
`update-history`, `capture-screen`, `capture-reset`, `display-toast`, `reset-view`, `save-dialog-open`, `screenshots-updated`, `theme-changed`, `widget-side`, `widget-direction`, `widget-config`, `viewer-image`, `viewer-list`, `viewer-window-state`, `quickpaste-show`, `update-info`, `update-available`, `update-downloaded`, `download-progress`, `update-error`

### 2.3 Pencere envanteri (9 tip)

| Pencere | Boyut | Bayraklar | Zorluk |
|---|---|---|---|
| `main` | 350×550 | frameless, transparent(mac), **vibrancy**, skipTaskbar, alwaysOnTop(screen-saver), allWorkspaces, blur'da gizlen | ● Orta |
| `capture` (×monitör) | display bounds | frameless, transparent, fullscreen/simpleFullscreen, alwaysOnTop(pop-up-menu), **contentProtection**, **ignoreMouseEvents**, enableLargerThanScreen | ●●● Yüksek |
| `widget` | 418×68 (ölçekli) | frameless, transparent, alwaysOnTop(screen-saver,1), showInactive, **zoomFactor**, sürüklenebilir, 10sn topmost yenileme | ●● Orta-Yüksek |
| `quickpaste` | 300×380 | frameless, transparent, **focusable:false**, showInactive, allWorkspaces | ●●● Yüksek |
| `toast` | 320×100 (dinamik) | frameless, transparent, ignoreMouseEvents(true), showInactive, allWorkspaces+skipTransformProcessType | ●● Orta |
| `viewer` | dinamik | frameless, resizable, maximize/minimize, **maximize overhang inset** hesabı | ●● Orta |
| `update` | 380×500 | frameless, transparent, alwaysOnTop | ● Düşük |
| `ocr` / `recorder` / `scroller` | capture ile aynı | + `setDisplayMediaRequestHandler` (mac) | ●●● Yüksek |

### 2.4 Kalıcı veri

`~/Library/Application Support/copyboard/config.json` (macOS) · `%APPDATA%\copyboard\config.json` (Windows)

Ölçülen gerçek anahtarlar (bu makinede: 307 geçmiş, 7 favori, 30 ekran görüntüsü):

```
history  favorites  screenshots
maxItems  quickPasteCount  autoStart  clipboardPaused  language  theme
videoQuality  audioMic  audioSystem
globalShortcut  globalShortcutImage  globalShortcutVideo  globalShortcutOcr
globalShortcutColor  globalShortcutScroll  globalShortcutPaste  shortcutsEnabled
showWidget  widgetPos  widgetSide  widgetDockParams
widgetTransparent  widgetColor  widgetOpacity  widgetScale
```

PNG dosyaları: `~/Library/Application Support/copyboard/screenshots/*.png` (en fazla 30 adet)

---

## 3. Hedef Mimari

```
CopyBoard/
├─ src/                          ← FRONTEND (değişmeden kalır)
│  ├─ renderer/                  ← 14.392 satır, olduğu gibi
│  │  └─ shared/
│  │     ├─ api-tauri.js         ← YENİ: preload.js'in Tauri karşılığı
│  │     └─ ...                  ← mevcut dosyalar
│  └─ shared/i18n/en.json        ← olduğu gibi
│
├─ src-tauri/                    ← YENİ: Rust ana süreç
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ capabilities/default.json  ← izin (ACL) tanımları
│  ├─ build.rs
│  └─ src/
│     ├─ main.rs                 ← app kurulumu, setup hook
│     ├─ state.rs                ← AppState (Mutex<Store>) — state.js karşılığı
│     ├─ store.rs                ← config.json okuma/yazma + debounce
│     ├─ migrate.rs              ← Electron config.json → Tauri göçü
│     ├─ i18n.rs                 ← t() + sözlük
│     ├─ theme.rs
│     ├─ windows/
│     │  ├─ mod.rs               ← ortak pencere kurucular
│     │  ├─ main_window.rs       ├─ capture.rs      ├─ widget.rs
│     │  ├─ quickpaste.rs        ├─ toast.rs        ├─ viewer.rs
│     │  └─ update.rs
│     ├─ platform/               ← OS'e özgü, cfg-gated
│     │  ├─ macos/
│     │  │  ├─ window_level.rs   ← NSWindow.level (screen-saver eşdeğeri)
│     │  │  ├─ vibrancy.rs       ├─ hotkey_carbon.rs  ← mac_hotkey.mm portu
│     │  │  ├─ paste_cgevent.rs  ← osascript yerine CGEventPost
│     │  │  ├─ frontmost_app.rs  ← NSWorkspace (Automation izni GEREKMEZ)
│     │  │  ├─ permissions.rs    ← TCC: ekran kaydı, mikrofon, erişilebilirlik
│     │  │  └─ pasteboard.rs     ← org.nspasteboard.ConcealedType tespiti
│     │  ├─ windows/
│     │  │  ├─ paste_sendinput.rs ← PowerShell yerine SendInput
│     │  │  ├─ clipboard_formats.rs ← "Clipboard Viewer Ignore" vb.
│     │  │  └─ window_ex.rs      ← WDA_EXCLUDEFROMCAPTURE, topmost
│     │  └─ linux/               ← Faz L
│     │     ├─ session.rs        ← XDG_SESSION_TYPE tespiti (x11 | wayland)
│     │     ├─ x11.rs            ← XGrabKey, XTest, EWMH always-on-top, konum
│     │     └─ wayland.rs        ← ashpd: GlobalShortcuts, ScreenCast, RemoteDesktop
│     ├─ clipboard/
│     │  ├─ watcher.rs           ← 1sn poll + gizli-pano filtresi
│     │  └─ history.rs           ← history-manager.js karşılığı
│     ├─ capture/
│     │  ├─ screenshot.rs        ← xcap: monitör başına yerel çözünürlük
│     │  ├─ recorder_mac.rs      ← ScreenCaptureKit + AVAssetWriter
│     │  ├─ recorder_win.rs      ← Graphics.Capture + Media Foundation
│     │  └─ scroll_stream.rs     ← kırpma bölgesi kare akışı (Channel)
│     ├─ ocr.rs                  ← tesseract-rs (eng+tur gömülü)
│     ├─ gallery.rs              ← screenshot-library.js karşılığı
│     ├─ shortcuts.rs            ← global-shortcut + Carbon köprüsü
│     ├─ tray.rs                 ├─ updater.rs      └─ commands/
│     │                                               ├─ core.rs
│     │                                               ├─ clipboard.rs
│     │                                               ├─ capture.rs
│     │                                               ├─ gallery.rs
│     │                                               ├─ viewer.rs
│     │                                               ├─ widget.rs
│     │                                               └─ update.rs
│
├─ src-electron-legacy/          ← eski src/main + src/preload (geçiş bitene dek)
└─ package.json                  ← yalnız @tauri-apps/cli + dev script
```

### 3.1 Temel ilke: **renderer'a dokunma**

`preload.js`'in dışa açtığı `window.api` yüzeyi **birebir korunur**. `api-tauri.js` aynı isimli fonksiyonları `invoke()` / `listen()` üzerine oturtur:

```js
// src/renderer/shared/api-tauri.js (özet)
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const boot = window.__COPYBOARD_BOOT__;   // initialization_script ile enjekte edilir

window.api = {
  platform: boot.platform,                  // 'darwin' | 'win32'
  i18n: boot.i18n,                          // senkron — bkz. §5.3
  theme: boot.theme,
  getHistory:      ()      => invoke('get_history'),
  copyItem:        (text)  => invoke('copy_item', { text }),
  onUpdateHistory: (cb)    => listen('update-history', e => cb(e.payload)),
  // ... 97 kanalın tamamı
};
```

Bu sayede `renderer.js`, `events.js`, `gallery.js`, `viewer.js`, `widget.js`, `snipper.js`, `quickpaste.js`, `toast.js`, `update-dialog.js` **hiç değişmez**.

### 3.2 Frontend derleme adımı yok

`tauri.conf.json` → `build.frontendDist: "../src/renderer"`. Bundler yok, `beforeDevCommand` yok. Her pencere kendi HTML'ini `WebviewWindowBuilder::new(app, label, WebviewUrl::App("snipper/snipper.html".into()))` ile yükler.

---

## 4. Electron → Tauri API Eşleme Tablosu

### 4.1 Uygulama & yaşam döngüsü

| Electron | Tauri v2 | Not |
|---|---|---|
| `app.whenReady()` | `.setup(\|app\| { .. })` | |
| `app.requestSingleInstanceLock()` + `second-instance` | `tauri-plugin-single-instance` | Birebir karşılığı var |
| `app.quit()` | `app.exit(0)` | |
| `app.on('before-quit')` | `RunEvent::ExitRequested` | Temizlik burada |
| `app.getVersion()` | `app.package_info().version` | |
| `app.getPath('userData')` | `app.path().app_data_dir()` | **Yol değişir** → §8 |
| `app.getPath('temp'\|'pictures'\|'videos')` | `app.path().temp_dir()` / `picture_dir()` / `video_dir()` | |
| `app.isPackaged` | `cfg!(debug_assertions)` tersi / `tauri::is_dev()` | |
| `app.setLoginItemSettings({openAtLogin, args:['--hidden']})` | `tauri-plugin-autostart` (`MacosLauncher`, `args`) | `--hidden` argümanı desteklenir |
| `app.dock.hide()` (macOS) | `app.set_activation_policy(ActivationPolicy::Accessory)` | |
| `app.focus({steal:true})` | `platform::macos::activate_app()` (NSApp `activate(ignoringOtherApps:)`) | Küçük FFI |
| `powerMonitor.on('suspend'\|'resume'\|'lock-screen'\|'unlock-screen')` | **Yok** → `NSWorkspace` bildirimleri (mac) + `WM_POWERBROADCAST`/`WTS` (win) | ~120 satır FFI |
| `process.on('uncaughtException')` + `dialog.showErrorBox` | `std::panic::set_hook` + `tauri-plugin-dialog` | |

### 4.2 Pencere

| Electron | Tauri v2 | Risk |
|---|---|---|
| `new BrowserWindow({...})` | `WebviewWindowBuilder::new(...)` | |
| `frame:false` | `.decorations(false)` | |
| `transparent:true` | `.transparent(true)` | Windows'ta ek not: §5.6 |
| `backgroundColor` | `.background_color(Color)` | |
| `skipTaskbar` | `.skip_taskbar(true)` | |
| `resizable/movable/fullscreenable` | aynı isimli builder metotları | |
| `hasShadow:false` | `.shadow(false)` | |
| `focusable:false` | `.focusable(false)` | ⚠ macOS'ta doğrulanmalı |
| `show:false` + `showInactive()` | `.visible(false)` + `win.show()` (focus çalmaz, `focusable(false)` ile) | ⚠ Spike |
| `alwaysOnTop:true` | `.always_on_top(true)` | |
| `setAlwaysOnTop(true,'screen-saver')` | **Yok** → `platform::macos::set_window_level(NSStatusWindowLevel+2)` | ⚠ FFI gerekli |
| `setAlwaysOnTop(true,'pop-up-menu')` | aynı, `NSPopUpMenuWindowLevel` | |
| `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen})` | `set_visible_on_all_workspaces(true)` | ⚠ Fullscreen davranışı için bilinen sorun (tauri#11488) — FFI ile `collectionBehavior` ayarı yedek plan |
| `setIgnoreMouseEvents(bool,{forward})` | `set_ignore_cursor_events(bool)` | ⚠ `forward:true` karşılığı yok — macOS'ta zaten varsayılan; Windows'ta `WS_EX_TRANSPARENT` ile mouse-move alınamaz → recorder toolbar hover mantığı yeniden kurgulanmalı (§5.5) |
| `setContentProtection(true)` | `set_content_protected(true)` | |
| `moveTop()` | `set_always_on_top(true)` tekrar / `NSWindow.orderFront` | |
| `minimize()/maximize()/unmaximize()/isMaximized()` | aynı isimli metotlar | |
| `setBounds/getBounds` | `set_position` + `set_size` / `outer_position` + `outer_size` | **Fiziksel piksel** — dikkat, §5.7 |
| `webContents.setZoomFactor(s)` | `webview.set_zoom(s)` | macOS+Windows destekli |
| `loadFile(path)` | `WebviewUrl::App("path/x.html".into())` | |
| `webContents.reload()` | `webview.eval("location.reload()")` | Dil değişiminde |
| `setWindowOpenHandler(deny)` | `tauri.conf.json` → `security.capabilities` + `on_navigation` | |
| `before-input-event` (Escape) | Renderer'da `keydown` + Rust'ta global Escape | Zaten karma yapı |
| `win.on('blur'/'focus')` | `WindowEvent::Focused(bool)` | |
| `sheet-begin` (macOS kaydet paneli) | **Yok** | §5.8 — spinner mantığı değişir |
| `simpleFullscreen` / `enableLargerThanScreen` | `set_size(monitor.size)` + `set_position(monitor.position)` + yüksek pencere seviyesi | Zaten manuel yapılıyor |
| Vibrancy (`vibrancy:'under-window'`) | `window-vibrancy` crate → `apply_vibrancy(NSVisualEffectMaterial::UnderWindowBackground)` | |

### 4.3 Ekran / monitör

| Electron | Tauri v2 |
|---|---|
| `screen.getAllDisplays()` | `app.available_monitors()` |
| `screen.getPrimaryDisplay()` | `app.primary_monitor()` |
| `screen.getCursorScreenPoint()` | `app.cursor_position()` |
| `screen.getDisplayNearestPoint(p)` | `app.monitor_from_point(x, y)` |
| `screen.getDisplayMatching(bounds)` | Elde hesaplanır (en çok kesişen monitör) |
| `display.workArea` | `Monitor::work_area()` (Tauri 2.x) |
| `display.scaleFactor` | `Monitor::scale_factor()` |
| `display.id` | `Monitor::name()` (String) — **id tipi değişir**, `widgetDockParams.displayId` göçü gerekir |
| `screen.on('display-added'/'removed'/'metrics-changed')` | **Yok** → `NSApplicationDidChangeScreenParameters` (mac) / `WM_DISPLAYCHANGE` (win) FFI, ya da 5sn'lik poll | ⚠ |

### 4.4 Pano

| Electron | Tauri v2 |
|---|---|
| `clipboard.readText()` / `writeText()` | `tauri-plugin-clipboard-manager` veya doğrudan `arboard` |
| `clipboard.writeImage(nativeImage)` | `arboard::Clipboard::set_image(ImageData)` (RGBA) |
| `clipboard.has('org.nspasteboard.ConcealedType')` | **Yok** → `platform::macos::pasteboard.rs` (`NSPasteboard.types`) |
| `clipboard.has('Clipboard Viewer Ignore')` | **Yok** → `platform::windows::clipboard_formats.rs` (`RegisterClipboardFormatW` + `IsClipboardFormatAvailable`) |
| 1sn `setInterval` poll | Windows: `AddClipboardFormatListener` (olay tabanlı, poll'dan iyi) · macOS: `NSPasteboard.changeCount` poll (aynı) |

### 4.5 Ekran yakalama

| Electron | Tauri v2 |
|---|---|
| `desktopCapturer.getSources({types:['screen'], thumbnailSize})` | `xcap::Monitor::all()` → `monitor.capture_image()` |
| `source.thumbnail.toPNG()` | `image::RgbaImage` → `PngEncoder` (veya ham RGBA + `ipc::Response`) |
| Boş kare + 5 deneme retry mantığı | Aynı mantık korunur (ScreenCaptureKit ilk kare gecikmesi Rust'ta da var) |
| `getUserMedia({chromeMediaSource:'desktop'})` — video | **Yok** → §5.1 |
| `setDisplayMediaRequestHandler(... audio:'loopback')` | **Yok** → ScreenCaptureKit `capturesAudio` (mac) / WASAPI loopback (win) |

### 4.6 Görüntü işleme

| Electron | Tauri v2 |
|---|---|
| `nativeImage.createFromBuffer(buf,{scaleFactor:1})` | `image::load_from_memory(&buf)` |
| `img.resize({w,h,quality:'best'})` | `image::imageops::resize(.., FilterType::Lanczos3)` |
| `img.crop({x,y,w,h})` | `DynamicImage::crop_imm` |
| `img.toJPEG(80)` | `image::codecs::jpeg::JpegEncoder::new_with_quality(.., 80)` |
| `img.getSize()` | `img.dimensions()` |
| `img.isEmpty()` | `Result` hatası |
| **DPI telafisi** (`scaleFactor: 1.0` numarası) | Rust'ta hiç yok — piksel neyse o. Bu, mevcut kodun en kırılgan kısmının **sadeleşmesi** demek. |

### 4.7 Kısayollar, tepsi, menü, diyalog

| Electron | Tauri v2 |
|---|---|
| `globalShortcut.register('Alt+9', cb)` | `tauri-plugin-global-shortcut` → `Shortcut::new(Some(Modifiers::ALT), Code::Digit9)` |
| `globalShortcut.isRegistered/unregister/unregisterAll` | Aynı isimli plugin metotları |
| Electron accelerator string ↔ Tauri `Shortcut` | **Çevirici yazılacak** (`shortcuts::parse_accelerator`) — store formatı korunur |
| `IntlBackslash` vb. fiziksel tuşlar | `global-hotkey` bunları **desteklemiyor** (doğrulandı) → `platform::macos::hotkey_carbon.rs` (mevcut `.mm` dosyasının Rust portu) |
| `Tray` + `Menu.buildFromTemplate` | `TrayIconBuilder` + `MenuBuilder` |
| `tray.popUpContextMenu()` | `tray.set_menu()` + `show_menu_on_left_click(false)` / `Menu::popup` |
| Menü açıkken kısayol askıya alma | Aynı `suspend/resume` mantığı korunur (macOS NSMenu modal döngüsü Tauri'de de var) |
| `Menu.popup({window})` (sağ tık) | `menu.popup_at(window, position)` |
| `dialog.showSaveDialog` | `tauri-plugin-dialog` → `FileDialogBuilder::save_file` |
| `dialog.showMessageBox` | `tauri-plugin-dialog` → `message`/`ask` |
| `dialog.showErrorBox` | `tauri-plugin-dialog` → `message` (Error türü) |
| `shell.openExternal(url)` | `tauri-plugin-opener` → `open_url` (http/https whitelist korunur) |
| `shell.showItemInFolder(path)` | `tauri-plugin-opener` → `reveal_item_in_dir` |
| `shell.openPath(dir)` | `tauri-plugin-opener` → `open_path` |

### 4.8 Depolama, güncelleme, izinler

| Electron | Tauri v2 |
|---|---|
| `electron-store` | Kendi `store.rs`'imiz: `serde_json` + atomik yazma + 500ms debounce (mevcut davranışın birebiri) |
| `electron-updater` (`autoUpdater`) | `tauri-plugin-updater` + `latest.json` + **imza anahtarı zorunlu** |
| `update-available/downloaded/progress/error` olayları | `update.download(on_chunk, on_finish)` → aynı isimli `emit` çağrıları |
| `autoUpdater.quitAndInstall` | `update.install()` + `app.restart()` |
| `systemPreferences.getMediaAccessStatus('screen')` | `platform::macos::permissions.rs` → `CGPreflightScreenCaptureAccess()` |
| `systemPreferences.askForMediaAccess('microphone')` | `AVCaptureDevice.requestAccess(for: .audio)` FFI |
| `systemPreferences.isTrustedAccessibilityClient(prompt)` | `AXIsProcessTrustedWithOptions()` FFI |
| `tesseract.js` (Node worker) | `tesseract-rs` (eng+tur **gömülü**) — 10 MB `.traineddata` dosyaları kalkar |

### 4.9 IPC

| Electron | Tauri v2 |
|---|---|
| `ipcRenderer.invoke(ch, ...)` / `ipcMain.handle` | `invoke('cmd', {..})` / `#[tauri::command] async fn` |
| `ipcRenderer.send(ch, ...)` / `ipcMain.on` | `invoke` (dönüşü yok sayılır) — Tauri'de tek yönlü kanal ayrımı yok |
| `webContents.send(ch, payload)` | `window.emit_to(label, "event", payload)` |
| Buffer/ArrayBuffer transferi (PNG, video chunk) | `tauri::ipc::Response::new(Vec<u8>)` (main→renderer) · `tauri::ipc::Request` raw body (renderer→main) |
| Akış (kaydırmalı yakalama kareleri) | `tauri::ipc::Channel<Vec<u8>>` |
| `sendSync` (senkron) | **Yok** → `initialization_script` (§5.3) |
| `BrowserWindow.fromWebContents(e.sender)` | `#[tauri::command] fn x(window: tauri::Window)` |

---

## 5. Kritik Riskler ve Çözümleri

### 5.1 ⛔ Video kaydı — Chromium'a bağımlı, tamamen yeniden yazılacak

**Bugün:** `recorder.js` → `getUserMedia({video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId}}})` → `MediaRecorder(webm/vp9)` → 1sn'lik `record-chunk` → ana süreçte `WriteStream`.

**Sorun:** WKWebView'da `chromeMediaSource` yok, `getDisplayMedia` da yok. Windows'ta WebView2 Chromium tabanlı ama `chromeMediaSource: 'desktop'` **Electron'a özgü bir uzantıdır**, WebView2'de yoktur. Yani **her iki platformda da** bu yol kapalı.

**Çözüm A — Yerel Rust encoder (ÖNERİLEN):**

| | macOS | Windows |
|---|---|---|
| Yakalama | `screencapturekit` crate (`SCStream`, macOS 12.3+) | `windows-capture` crate (`Graphics.Capture`, Win10 1903+) |
| Kırpma | `SCContentFilter` + `sourceRect` | Frame üzerinde crop |
| Sistem sesi | **SCStream `capturesAudio: true`** — BlackHole gerekmez ✅ | WASAPI loopback (`windows` crate) |
| Mikrofon | `AVCaptureDevice` / `cpal` | `cpal` (WASAPI) |
| Ses karıştırma | Rust'ta örnekleme + toplama (bugün Web Audio yapıyor) | aynı |
| Encode/mux | `AVAssetWriter` (H.264 + AAC → `.mp4`) | Media Foundation `SinkWriter` (H.264 + AAC → `.mp4`) |
| Kalite ayarı | bitrate: yüksek 8 Mbps / orta 4 / düşük 2 (mevcut değerler korunur) | aynı |

Renderer tarafı (`recorder.js`) yalnız **UI** olarak kalır: seçim dikdörtgeni, toolbar, sayaç, ses düğmeleri. `record-start` artık Rust'a "şu monitörün şu dikdörtgenini, şu kalitede, şu ses kaynaklarıyla kaydet" der; kareler hiç webview'a uğramaz. Bu, bugünkü `record-chunk` IPC trafiğini de tamamen ortadan kaldırır.

**Çözüm B — ffmpeg sidecar (yedek plan):** `ffmpeg` binary'si `externalBin` olarak paketlenir; macOS `-f avfoundation -i "1:0"`, Windows `-f gdigrab`. Hızlı yazılır ama: +45 MB paket, macOS 14+'ta avfoundation ekran girişi güvenilmez, Windows'ta WASAPI loopback girişi yok (sistem sesi kaybedilir), GPL binary dağıtım yükümlülüğü.

**Karar:** Çözüm A — ✅ **Spike-4 ile ispatlandı** ([sonuçlar](TAURI_SPIKE_RESULTS.md#s4--video-kaydı--kapı-spikeı)).
29,4 fps kırpılmış yakalama, sistem sesi BlackHole'suz, geçerli H.264/mp4. B planı rafa kalktı.

### ⚠ Asgari macOS sürümü — karar gerekiyor

Spike-4, mp4'ü `SCRecordingOutput` ile üretti; o **macOS 15.0+** ister. Bugünkü
`MACOSX_DEPLOYMENT_TARGET` 11.0.

| Yol | Asgari macOS | Ek iş | Kontrol |
|---|---|---|---|
| `SCRecordingOutput` | 15.0 | ~sıfır | bitrate/kalite sınırlı |
| SCStream + `objc2-av-foundation` | **12.3** | ~1,5 hafta | tam (bitrate, kalite kademeleri, ses karıştırma) |

**Öneri: macOS 12.3 + `objc2-av-foundation`.** ScreenCaptureKit'in kendisi zaten 12.3
istediği için 11.0 desteği bu özellik açısından zaten teoriktir. Uygulamanın geri kalanı
(pano, alıntı, OCR) 11.0'da çalışmaya devam edebilir; yalnız video 12.3 ister.

> Not: ilk tasarımdaki `avassetwriter` crate'i macOS 26 SDK'sıyla derlenmiyor
> (Swift köprüsü altyazı kodunda patlıyor) — bu yüzden `objc2-av-foundation` ile
> doğrudan bağlanılacak, üçüncü parti Swift köprüsü kullanılmayacak.

---

### 5.2 ⛔ Kaydırmalı yakalama — kare akışı webview'a taşınmalı

**Bugün:** `scroller.js` canlı masaüstü akışından (`getUserMedia`) ~20 fps kare çeker, `stitcher.js` (476 satır) karelerin örtüşmesini bulup dikey olarak birleştirir.

**Sorun:** Akış kaynağı §5.1 ile aynı sebepten yok.

**Çözüm:** Kare üretimi Rust'a, birleştirme JS'te kalır.

```
Rust: SCStream/Graphics.Capture → crop(bölge) → ham RGBA
   → tauri::ipc::Channel<Vec<u8>> → renderer
   → new ImageData(new Uint8ClampedArray(buf), w, h) → putImageData → mevcut stitcher.js
```

**Bant genişliği hesabı:** tipik kırpma 900×700 = 2,52 MB/kare. 15 fps'te **37,8 MB/sn**. Tauri IPC bunu kaldırır (Channel ham byte taşır, JSON serialize etmez) ama ölçülmeli.

Ölçüm eşiğe takılırsa, sırayla:
1. Kare hızını 10 fps'e düşür (birleştirme zaten hareket eşiğine bakıyor).
2. Ham RGBA yerine **BGRA→gri tonlama** gönder (`stitcher.js` eşleştirmeyi zaten parlaklık profili üzerinden yapıyor — `PROFILE_W` sütun ortalaması). Bu, veriyi **4 kat** azaltır.
3. Son çare: `stitcher.js`'i Rust'a portla (476 satır, saf algoritma, test dosyası `test/stitcher.test.mjs` mevcut → port doğrulanabilir).

**Not:** Yakalama sırasında overlay `setContentProtection(true)` ile kendini akıştan dışlıyor. Rust tarafında ScreenCaptureKit `SCContentFilter.excludingWindows([overlayWindow])` ile bu **daha temiz** çözülür.

---

### 5.3 ⚠ Senkron preload (`i18n-get`, `theme-get`)

**Bugün:** `preload.js` sayfa scriptleri çalışmadan **önce** `ipcRenderer.sendSync` ile sözlüğü ve temayı alıyor; `shared/i18n.js` ilk geçişte HTML'i çeviriyor, `shared/theme.js` `<html data-theme>` bayrağını basıyor. Bu yüzden hiçbir pencere önce koyu sonra açık diye **titremiyor**.

**Tauri'de senkron IPC yoktur.** Çözüm: pencere kurulurken script enjekte etmek.

```rust
let boot = serde_json::json!({
    "platform": if cfg!(target_os="macos") { "darwin" } else { "win32" },
    "i18n":  { "lang": lang, "dict": dict },
    "theme": { "mode": mode, "resolved": resolved },
});
WebviewWindowBuilder::new(app, label, url)
    .initialization_script(&format!("window.__COPYBOARD_BOOT__ = {};", boot))
    .build()?;
```

`initialization_script` **sayfanın kendi scriptlerinden önce** çalışır — davranış birebir korunur. `api-tauri.js` bunu okuyup `window.api.i18n` / `window.api.theme` olarak sunar.

**Dikkat:** Dil değiştiğinde bugün tüm pencereler `reload()` ediliyor. Tauri'de `initialization_script` pencere kurulumunda sabitlenir; `location.reload()` sonrası **aynı** script tekrar çalışır (Tauri bunu her navigasyonda enjekte eder) ama **eski sözlükle**. Bu yüzden dil değişiminde ya (a) pencereler yeniden **oluşturulur**, ya da (b) `reload` öncesi `webview.eval("window.__COPYBOARD_BOOT__.i18n = {...}")` ile güncellenir. **(b) seçilir** — daha az yıkıcı.

---

### 5.4 ⚠ macOS pencere seviyeleri (`screen-saver`, `pop-up-menu`)

Tauri'nin `set_always_on_top(true)` çağrısı macOS'ta `NSFloatingWindowLevel` (3) kullanır. Uygulama bugün `screen-saver` (1000) ve `pop-up-menu` (101) seviyelerini kullanıyor — yakalama overlay'i, widget, toast ve hızlı yapıştır **her şeyin üstünde** durmak zorunda.

**Çözüm:** `objc2` + `objc2-app-kit` ile ham `NSWindow` tutamacı üzerinden:

```rust
// src-tauri/src/platform/macos/window_level.rs
pub fn set_level(window: &tauri::WebviewWindow, level: i64) {
    if let Ok(ptr) = window.ns_window() {
        unsafe { let ns: &NSWindow = &*(ptr as *const NSWindow); ns.setLevel(level); }
    }
}
// NSStatusWindowLevel=25, NSPopUpMenuWindowLevel=101, NSScreenSaverWindowLevel=1000
```

Aynı dosya `collectionBehavior` (`.canJoinAllSpaces | .fullScreenAuxiliary`) ayarını da yapar — bu, bilinen `visibleOnAllWorkspaces` + fullscreen sorununun (tauri#11488) da çözümüdür.

Windows tarafında `HWND_TOPMOST` + `SetWindowPos` zaten `always_on_top` ile geliyor; widget'ın 10sn'lik yeniden-topmost döngüsü aynen korunur.

---

### 5.5 ⚠ `setIgnoreMouseEvents(true, { forward: true })`

**Bugün:** Recorder ve scroller, fare toolbar'ın üstünde değilken pencereyi tıklama-geçirgen yapıyor, ama `forward:true` sayesinde `mousemove` olaylarını **almaya devam ediyor** — bu olmadan fare toolbar'a geri geldiğinde pencere tekrar etkileşimli olamaz.

Tauri'de `set_ignore_cursor_events(true)` `forward` parametresi almaz. macOS'ta `ignoresMouseEvents` zaten `mouseMoved` olaylarını NSTrackingArea üzerinden engellemez → sorun yok. **Windows'ta `WS_EX_TRANSPARENT` fare olaylarını tamamen keser → toolbar'a dönüş imkânsız hale gelir.**

**Çözüm (Windows):** Fare konumu Rust tarafında `GetCursorPos` ile 30ms'de bir örneklenir; toolbar dikdörtgenine (renderer'ın `record-start`'ta bildirdiği ekran koordinatları) girildiğinde `set_ignore_cursor_events(false)`, çıkıldığında `true`. Bu, bugünkü `updateIgnoreMouse` mantığının Rust'a taşınmış hali. Toolbar hareket ettiğinde renderer yeni dikdörtgeni bildirir.

---

### 5.6 ⚠ Şeffaflık ve vibrancy

- **macOS:** `.transparent(true)` + `window-vibrancy::apply_vibrancy(&win, NSVisualEffectMaterial::UnderWindowBackground, None, None)`. Mevcut `vibrancy:'under-window'` + `visualEffectState:'active'` davranışının karşılığı.
- **Windows:** `transparent:true` zaten yalnızca `decorations(false)` ile kullanılıyor — mevcut kodda ana pencere Windows'ta şeffaf değil (`transparent: process.platform === 'darwin'`), yani risk yok. Widget/toast/quickpaste Windows'ta da şeffaf; WebView2 ile `backgroundColor: #00000000` + `transparent` çalışır, ancak **spike ile doğrulanacak** (bilinen tauri#8308).
- `backdrop-filter` (16 kullanım): WKWebView'da desteklenir, WebView2'de desteklenir. Görsel fark için ekran görüntüsü karşılaştırması yapılacak.

---

### 5.7 ⚠ Mantıksal piksel ↔ fiziksel piksel

Electron `setBounds`/`getBounds` **mantıksal (DIP)** piksel kullanır. Tauri `PhysicalPosition`/`PhysicalSize` ve `LogicalPosition`/`LogicalSize` ayrımı yapar; varsayılan `outer_position()` **fizikseldir**.

Etkilenen kod: widget konumlandırma (`widgetPos`, `widgetDockParams.relX/relY`), toast konumu, quickpaste imleç konumu, viewer maximize-overhang hesabı, capture overlay bounds.

**Doğrulanmış davranış:**
- `WebviewWindowBuilder::inner_size(w, h)` ve `::position(x, y)` → **mantıksal** piksel
- `Monitor::size()` / `position()` / `work_area()` → **fiziksel** piksel (`PhysicalSize` / `PhysicalPosition` / `PhysicalRect`)
- `Window::outer_position()` / `outer_size()` → **fiziksel**
- `Window::set_position(LogicalPosition)` / `set_size(LogicalSize)` → tip ile seçilir

**Kural:** Rust tarafında tek bir `geom.rs` modülü olacak; monitör bilgisi okunur okunmaz `scale_factor()` ile **mantıksala çevrilecek**, tüm pencere hesapları mantıksal yapılacak, yalnız yakalama çağrılarında fiziksele dönülecek. Bu, kayıtlı `widgetPos` / `widgetDockParams` değerlerinin göç sonrası anlamını korumasını sağlar; `captureWidth = bounds.width * scaleFactor` mantığı ise birebir korunur.

**Tuzak:** Bu iki dünyayı karıştırmak, 2x ekranda widget'ı ekranın dışına atan ve toast'u yanlış monitörde açan sınıf hatalar üretir. Faz 1'de `geom.rs` için birim testi yazılacak.

---

### 5.8 ⚠ macOS kaydet paneli `sheet-begin` olayı

`capture-handlers.js` panelin gerçekten ekrana geldiğini `parent.once('sheet-begin')` ile ölçüp renderer'a `save-dialog-open` gönderiyor (spinner'ı erken durdurmamak için). Tauri'de bu olay yok.

**Çözüm:** `tauri-plugin-dialog`'un `save_file` çağrısı **async callback**'lidir. Panel açılışı ile çağrının dönüşü arasındaki fark Tauri'de yoktur (çağrı bloklamaz). `save-dialog-open` olayı `save_file` çağrısından **hemen önce** gönderilir; ölçülen 647ms/910ms farkı Tauri'de oluşmaz çünkü `showSaveDialog`'un senkron bekleme davranışı yoktur. Beta'da doğrulanacak; gerekirse 250ms sabit gecikme eklenir.

---

### 5.9 ⚠ OCR

`tesseract-rs` crate'i Tesseract + Leptonica'yı **build sırasında derler** ve `eng`+`tur` verilerini **binary'ye gömer**. Kazanç:

- `eng.traineddata` (5,2 MB) + `tur.traineddata` (4,7 MB) `extraResources`'tan çıkar
- `capture-handlers.js`'teki ~150 satırlık worker yaşam döngüsü kodu (timeout, idle release, thread ölüm takibi, cachePath/langPath numarası) **tamamen silinir**
- OCR ana thread'i bloklamaz: `tauri::async_runtime::spawn_blocking`

Maliyet: ilk `cargo build` ~10–15 dk (CI'da `sccache`/`Swatinem/rust-cache` ile bir kez).

**Yedek plan:** Gizli bir `ocr-worker` WebviewWindow'da `tesseract.js` WASM olarak çalıştırılır (traineddata `asset:` protokolü ile yüklenir). Daha yavaş ama garantili.

---

### 5.10 ⚠ Gizli pano (password manager) tespiti

`clipboard.has('org.nspasteboard.ConcealedType')` — Rust karşılığı yok, ama iki platformda da ~30 satır:

```rust
// macOS
let pb = unsafe { NSPasteboard::generalPasteboard() };
let types = unsafe { pb.types() };  // NSArray<NSPasteboardType>
types.iter().any(|t| t == "org.nspasteboard.ConcealedType" || t == "org.nspasteboard.TransientType")

// Windows
let cf = unsafe { RegisterClipboardFormatW(w!("Clipboard Viewer Ignore")) };
unsafe { IsClipboardFormatAvailable(cf).is_ok() }
```

Bu davranış **kaybedilmemeli** — parola yöneticisi içerikleri geçmişe düşerse gerçek bir güvenlik gerilemesidir.

---

### 5.11 ⚠ `focusable: false` + `showInactive` (Hızlı Yapıştır'ın kalbi)

Hızlı Yapıştır penceresi, kullanıcının yazdığı alandan odağı **çalmamak** üzerine kurulu; yoksa Cmd+V yanlış yere gider. Tauri `.focusable(false)` sunar ama macOS'ta `NSPanel` yerine `NSWindow` kullanır — davranış farkı olabilir.

**Spike-2 bunu ilk hafta ispatlayacak.** İspatlanmazsa: `platform::macos` içinde pencereyi `NSPanel` + `NSWindowStyleMask::NonactivatingPanel` olarak yeniden yapılandırmak (objc2 ile ~40 satır) kesin çözümdür.

---

### 5.12 ⚠ Güncelleyici (imza zorunluluğu)

`tauri-plugin-updater` **imzasız güncelleme kabul etmez**. Gerekenler:

1. `tauri signer generate` → private/public anahtar çifti
2. Private key + parola → GitHub Actions secret (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
3. Public key → `tauri.conf.json` → `plugins.updater.pubkey`
4. CI, release'e `latest.json` üretir (`tauri-action` bunu otomatik yapar)

**macOS:** Bugün uygulama imzasız (`identity: null` + ad-hoc imza) ve bu yüzden `electron-updater` macOS'ta devre dışı — kullanıcı GitHub'dan elle indiriyor. Tauri'de de **aynı politika korunacak** (macOS'ta `download-update` engellenir, dialog manuel indirmeye yönlendirir). Apple Developer sertifikası alınırsa bu kısıt ayrı bir iş kaleminde kaldırılır.

**Kritik:** v2.12.0 (Electron) → v3.0.0 (Tauri) geçişi **electron-updater ile yapılamaz**. Electron sürümü kendi güncelleyicisiyle Tauri paketini kuramaz (NSIS farklı, .app farklı). Geçiş stratejisi §8.3'te.

---

### 5.13 ⚠ `-webkit-app-region: drag`

6 kullanım (`main-window/styles.css:82`, `viewer.css:68`, ilgili `no-drag` kuralları). WKWebView bunu **desteklemez**.

**Çözüm:** İlgili elemanlara `data-tauri-drag-region` niteliği eklenir; CSS kuralları silinir. `no-drag` alanları için niteliğin **olmaması** yeterlidir. Widget'ın sürüklenmesi zaten `widget-action:'drag'` IPC'si ile manuel yapılıyor — o değişmez.

---

### 5.14 ⛔ Linux — WebKitGTK ve Wayland gerçeği

Linux kapsama alındı. Ancak CopyBoard'un çekirdek davranışlarının dördü, **Wayland'ın güvenlik modeli tarafından mimari olarak yasaklanmıştır.** Bu bir Tauri eksiği değildir; Electron sürümü Linux'a portlansa aynı duvara çarpardı.

| Yetenek | X11 | Wayland | CopyBoard'da neyi kırar |
|---|---|---|---|
| Pencerenin kendi konumunu belirlemesi | ✅ | ❌ **Protokolde yok** | Widget'ın köşeye yapışması, toast'un imleç monitöründe açılması, hızlı yapıştırın imlecin yanına gelmesi, capture overlay'in doğru monitöre oturması |
| Global kısayol | ✅ (`XGrabKey`) | ⚠ Yalnız `org.freedesktop.portal.GlobalShortcuts` ile (GNOME 45+, KDE 6+) | 7 kısayolun tamamı |
| Tuş vuruşu sentezleme (Ctrl+V) | ✅ (`XTest`) | ❌ Yalnız portal RemoteDesktop / `uinput` (root) | Hızlı Yapıştır'ın "doğrudan yapıştır" özelliği |
| Always-on-top | ✅ (EWMH) | ❌ Uygulama isteyemez | Overlay, widget, toast, hızlı yapıştır |
| Ekran yakalama | ✅ (`XGetImage`) | ⚠ Portal ScreenCast (PipeWire) + her seferinde izin diyaloğu (restore token ile bir kez) | Alıntı, OCR, renk, video, kaydırmalı |
| Pano izleme | ✅ | ⚠ `wlr-data-control` (Sway/Hyprland ✅, **GNOME ❌**) | Pano geçmişinin kendisi |
| Sistem tepsisi | ⚠ `libayatana-appindicator` | ⚠ aynı + GNOME'da eklenti gerekir | Tepsi menüsü |

**Sonuç:** Wayland + GNOME (Ubuntu 24.04, Fedora Workstation varsayılanı) kombinasyonunda **pano geçmişi bile arka planda izlenemez**. Bu, uygulamanın 1 numaralı özelliğidir.

**Önerilen Linux stratejisi — üç kademeli:**

1. **X11: tam destek.** Tüm özellikler çalışır. `xcap` X11 yakalamayı, `global-hotkey` `XGrabKey`'i, `arboard` panoyu, `enigo`/`XTest` yapıştırmayı halleder. Hedef: Ubuntu 22.04 X11 oturumu, KDE X11.
2. **Wayland: portal destekli kısmi destek.** `ashpd` crate'i ile `GlobalShortcuts`, `ScreenCast` (restore token) ve `RemoteDesktop` portalları kullanılır. Konum belirleyemeyen pencereler (widget, toast, quickpaste) **davranış değiştirir**: widget yerine tepsi menüsü, toast yerine `org.freedesktop.Notifications`, imleç yanı yerine ekran ortası.
3. **Wayland + GNOME pano:** `wlr-data-control` yok. Yedek: GNOME'un kendi pano geçmişi eklentisiyle çakışmamak üzere **pano izleme kapalı**, kullanıcı elle "geçmişe ekle" kısayoluyla ekler. Dürüst çözüm budur; sessizce çalışmıyormuş gibi davranmak değil.

**Bu, uygulamanın Linux'ta ikinci bir davranış modeli** demektir. Kod tarafında `platform/linux/` altında `x11.rs` ve `wayland.rs` ayrımı + çalışma anında oturum tipi tespiti (`XDG_SESSION_TYPE`) gerekir. Efor: **+4 hafta**, ve bunun yarısı Wayland kısıtlarını kullanıcıya dürüstçe anlatan UI işidir.

**WebKitGTK notları (Wayland'dan bağımsız):**
- `backdrop-filter`: WebKitGTK 2.44+ destekliyor, eski dağıtımlarda yok → `@supports` fallback (16 kullanım)
- `-webkit-scrollbar`: WebKitGTK destekler ✅
- `<input type=range>` özel stilleri: doğrulanmalı
- Şeffaf pencere: bileşik yöneticiye (compositor) bağlı; GNOME/KDE ✅, i3 without picom ❌
- **Paketleme:** `.AppImage` + `.deb` (Tauri her ikisini üretir); `.rpm` ayrı iş

**Karar önerisi:** v3.0.0'ı **macOS + Windows** ile çıkarmak, Linux'u **v3.1.0** olarak X11-tam / Wayland-kısmi şeklinde ayrı bir sürümde yayınlamak. Böylece Linux'un iki-modelli karmaşıklığı, çekirdek göçün riskine eklenmez. Plan bu şekilde yazıldı: Linux işi Faz L olarak ayrıştırıldı ve Faz 7'den sonraya konuldu, ama tasarım kararları (özellikle `platform/` katmanı) baştan üç platformu varsayar.


---

## 6. Faz 0 — Doğrulama Spike'ları (1,5 hafta, GEÇ/KAL kapısı)

> 📊 **Ölçülmüş sonuçlar: [TAURI_SPIKE_RESULTS.md](TAURI_SPIKE_RESULTS.md)** — 2026-08-30 itibarıyla
> S1 ✅ · S2 ✅ · S3 ✅ · S4 ✅ · S5 ✅ · S6 ✅ · S7 ✅ · S8 ✅ · S9–S11 ⏳ (Linux makinesi)
>
> **macOS/Windows çekirdeği için Faz 0 TAMAMLANDI — yedi spike, yedi geçiş, dokuz bulgu.**
>
> **🟢 KAPI AÇILDI — zorunlu dördün dördü de geçti (S1, S2, S4, S7).**
> Projeyi durdurabilecek tek risk olan video kaydı ölçümle kapatıldı: ScreenCaptureKit ile
> kırpılmış, **sistem sesli** (BlackHole'suz), oynatılabilir H.264/mp4 üretildi.
> ffmpeg yedek planına (§5.1-B) gerek yok — plan yazıldığı gibi yürüyor.
>
> Faz 0'ın ürettiği bulgular: AppKit FFI'sının ana thread zorunluluğu · debug build'in
> performans ölçümüne uygunsuzluğu · Swift runtime rpath'i · `avassetwriter` crate'inin
> macOS 26 SDK uyumsuzluğu · `init_embedded()`'in tek dil kısıtı ·
> **asgari macOS sürümü kararı** (§5.1'e eklendi).

Her spike ayrı bir dal ve tek bir soruyu **ölçerek** yanıtlar. Hiçbiri ürün kodu üretmez.

| # | Soru | Kanıt | Süre | Başarısızsa |
|---|---|---|---|---|
| **S1** | 9 pencere tipinin bayrakları Tauri'de kurulabiliyor mu? (frameless + transparent + vibrancy + screen-saver seviyesi + allWorkspaces + contentProtected + ignoreCursor) | Her bayrak için macOS ve Windows'ta ekran görüntüsü | 2 gün | FFI miktarı artar, süre +1 hafta |
| **S2** | `focusable:false` pencere macOS'ta odak çalmıyor mu? Cmd+V hedef uygulamaya gidiyor mu? | TextEdit'e yapıştırma videosu | 0,5 gün | `NSPanel` FFI (+2 gün) |
| **S3** | `xcap` ile 2 monitörlü, farklı DPI'lı yakalama Electron kalitesinde mi? | 4K + 1080p yan yana, piksel karşılaştırma | 1 gün | `screencapturekit` doğrudan kullanılır |
| **S4** | **ScreenCaptureKit + AVAssetWriter ile 30sn'lik kırpılmış, sistem sesli mp4 üretilebiliyor mu?** (macOS) / **Graphics.Capture + SinkWriter** (Windows) | Oynatılabilir mp4 dosyası | 3 gün | ffmpeg sidecar planına geç (§5.1-B) |
| **S5** | Kırpma bölgesi kare akışı Channel üzerinden 15 fps'te akıyor mu? | `performance.now()` histogramı, düşen kare sayısı | 1 gün | gri tonlama → sonra stitcher portu |
| **S6** | `tesseract-rs` eng+tur ile mevcut OCR kalitesini veriyor mu? Build süresi CI'da kabul edilebilir mi? | 10 örnek görüntü, Electron çıktısıyla diff | 1 gün | gizli webview + tesseract.js |
| **S7** | `initialization_script` sayfa scriptlerinden önce çalışıyor mu? Tema titremesi var mı? | Yavaşlatılmış kayıt | 0,5 gün | `visible:false` + hazır olunca `show()` |
| **S8** | Carbon `RegisterEventHotKey` Rust'tan çalışıyor mu? Tauri'nin kendi global-shortcut'ı ile çakışmıyor mu? | Türkçe-Q klavyede `Cmd+"` tetikleniyor | 1 gün | Bu özellik geçici olarak kapatılır |

| **S9** | Linux X11'de: konum belirleme + always-on-top + `XGrabKey` + pano izleme çalışıyor mu? | Ubuntu 22.04 X11 VM'de widget köşeye yapışıyor | 1 gün | Linux X11 desteği de düşer |
| **S10** | Wayland'da `ashpd` ile GlobalShortcuts + ScreenCast portalı (restore token) çalışıyor mu? | GNOME 46'da kısayol tetikleniyor, ikinci yakalamada izin sorulmuyor | 1,5 gün | Wayland "kısıtlı mod"a düşer (§5.14/3) |
| **S11** | WebKitGTK mevcut CSS'i doğru render ediyor mu? | 9 pencerenin macOS ile yan yana ekran görüntüsü | 0,5 gün | `@supports` fallback'leri yazılır |

**Kapı kuralı:** S1, S2, S4, S7 **zorunlu geçer** — bunlar macOS+Windows çekirdeğidir. S4 geçmezse ffmpeg planına geçilir ama proje durmaz. S9–S11 **Linux kapsamının kapısıdır**; S9 bile geçmezse Linux tamamen kapsam dışına alınır ve takvim 15–17 haftaya döner. Diğerleri geçmezse yedek plan devreye girer.

---

## 7. Faz Planı

Her fazın sonunda **çalışan bir uygulama** vardır. Electron sürümü `src-electron-legacy/` altında Faz 7'ye kadar bozulmadan durur; `npm run start:electron` ile her an karşılaştırma yapılabilir.

### Faz 1 — İskelet ve pencere altyapısı ✅ TAMAMLANDI

> 2.375 satır Rust + 224 satır `api-tauri.js` · 24 birim testi geçiyor
> Electron sürümü regresyonsuz çalışmaya devam ediyor (`npm run start:electron`)

**1.1 Toolchain** ✅
- [x] Rust 1.98.0 (rustup), `src-tauri/` iskeleti, `tauri.conf.json`, `capabilities/`
- [x] `.cargo/config.toml`: Swift rpath (S4-a) + `MACOSX_DEPLOYMENT_TARGET=12.3` (S4-d kararı)
- [x] `[profile.dev.package."*"] opt-level = 3` — bağımlılıklar debug'da da optimize (S3-a)
- [x] `package.json`: `dev`/`build` → tauri; `start:electron` eski davranışı koruyor
- [x] `.gitignore`: `src-tauri/target/`, `src-tauri/gen/`

**1.2 Uygulama kabuğu** ✅
- [x] `main.rs` + `lib.rs`: Builder, single-instance, `ActivationPolicy::Accessory`, panik kancası
- [x] `tauri-plugin-log`: konsol + dosya (F1-d — bu olmadan hata ayıklama körlemesine)
- [x] `store.rs`: electron-store semantiği — eksik anahtar → varsayılan, **tanınmayan
      anahtarlar korunur**, atomik yazma, 500 ms debounce, `flush()`, bozuk JSON yedekleme
- [x] `migrate.rs`: Electron → Tauri göçü (**kopyala, taşıma**) + `state.js` sanitizasyonu
- [x] `i18n.rs` (gömülü `en.json`, Türkçe kaynak dil) + `theme.rs` (mod ↔ çözümlenmiş)
- [x] `state.rs`: `Runtime` + tipli `Settings` (varsayılanlar TEK yerde)
- [x] `geom.rs`: mantıksal ↔ fiziksel piksel sınırı (S1-b, F1-b)

**1.3 Pencere fabrikası** ✅
- [x] `windows/mod.rs`: `WindowSpec` + `build()` + `boot_script()` (senkron preload'un yerine)
- [x] `platform/macos/`: `NSWindow.level`, `collectionBehavior`, vibrancy, `orderFront`,
      `activateIgnoringOtherApps` — **hepsi `run_on_main_thread` üzerinden** (S1-a)
- [x] `platform/mod.rs`: `WindowLevel` soyutlaması, `hide_dock`, `join_all_spaces`
- [x] Ana pencere: imleç monitöründe sağ alt, blur davranışı (`SHOW_SETTLE_MS`,
      `main_was_focused`), tepsi aç/kapa koruması (`TOGGLE_GUARD_MS`)
- [x] Toast: tekil ve yeniden kullanılan pencere, imleç monitöründe, tıklama geçirgen,
      renderer'ın bildirdiği yüksekliğe göre boyutlanan

**1.4 IPC köprüsü** ✅
- [x] `api-tauri.js`: **`preload.js`'in 98 metodunun tamamı** karşılandı (otomatik
      karşılaştırmayla doğrulandı: eksik yok). Taşınmamış olanlar tanımlı kalıp bir kez
      uyarı basıyor — renderer `undefined is not a function` ile ölmüyor.
- [x] `commands/core.rs`: `get_history`, `get_settings`, tema/dil, pencere, toast, debug
- [x] 10 HTML'e `api-tauri.js` bağlandı — **her birinde `theme.js`'ten ÖNCE**
      (senkron okuma zorunluluğu), otomatik doğrulandı
- [x] CSP'ler `ipc:` ve `asset:` için genişletildi
- [x] `icon.png` renderer ağacına alındı (F1-e) — iki sürümde de çalışan yol

**Kabul kriteri — karşılandı:** Ana pencere açılıyor, **339 göç edilmiş kayıt**
listeleniyor, Türkçe arayüz, koyu tema (titreme yok), toast doğru monitörde görünüyor,
ayarlar okunuyor. Electron verisi el değmemiş duruyor.

### Faz 2 — Pano, tepsi, kısayollar ✅ TAMAMLANDI

> 46 birim testi geçiyor · `unsafe` yalnız `platform/` FFI katmanında

**2.1 Pano izleyici** ✅
- [x] `platform/macos/pasteboard.rs` — `NSPasteboard` üzerinden `changeCount`, gizli tip
      tespiti, metin oku/yaz. **`arboard` değil**, çünkü ikisi de ondan alınamıyor.
- [x] `platform/windows/clipboard_formats.rs` — `GetClipboardSequenceNumber`,
      üç sentinel format (`Clipboard Viewer Ignore` vb.)
- [x] `clipboard/watcher.rs` — 1 sn yoklama, **önce sayaç sonra metin**: Electron her
      saniye `readText()` çağırıyordu; büyük bir kopya panodayken bu, saniyede
      megabaytların kopyalanması demekti. Boşta maliyet artık bir tam sayı karşılaştırması.
- [x] Pano okuması ana thread'e devrediliyor (BULGU S1-a kuralı), ana thread meşgulse
      tur atlanıyor (2 sn zaman aşımı) — izleyici asla kilitlenmiyor
- [ ] Uyku/kilit duraklatma — **bilinçli olarak ertelendi**: Electron'daki gerekçe
      saniyede bir tam panoyu okumaktı; `changeCount` ile o maliyet ortadan kalktığı için
      duraklatmanın kazancı kalmadı. Store zaten çıkışta boşaltılıyor.

**2.2 Geçmiş ve favoriler** ✅
- [x] `clipboard/history.rs`: ekle (tekilleştirme + **not koruma**), sil, temizle,
      favori CRUD, not, yeniden sıralama, `MAX_ITEM_CHARS` (bütün-ya-da-hiç)
- [x] Yeniden sıralama **uzunluk doğrulaması** ile: renderer'dan gelen kısa bir liste
      geçmişi sessizce silerdi
- [x] Yayın yalnız GÖRÜNÜR pencerelere
- [x] `commands/clipboard.rs`: 11 komut

**2.3 Tepsi** ✅
- [x] `tray.rs`: `TrayIconBuilder`, 8 öğeli menü, dile ve kısayola göre yeniden inşa
- [x] macOS: sol tık → aç/kapa, sağ tık → menü (`show_menu_on_left_click(false)`)
- [x] Menüdeki accelerator'lar — keşfedilebilirlik için değil, **NSMenu modal döngüsünde
      kısayolun çalışabilmesi** için
- [x] Accelerator ayrıştırma hatası tek bir öğeyi tuş ipucundan eder, **tepsiyi düşürmez**

**2.4 Global kısayollar** ✅
- [x] `shortcuts/accelerator.rs`: Electron ↔ Tauri çevirisi, `accelerator.js`'in ürettiği
      **tüm sözlüğe** karşı test edildi (harf/rakam/numpad/F1-F24 aileleri dahil)
- [x] **`ShortcutState::Pressed` filtresi** (BULGU S8-a) — olmadan yedi kısayolun tamamı
      iki kez çalışırdı
- [x] `platform/macos/hotkey_carbon.rs`: `mac_hotkey.mm`'in Rust portu, kayıt SÖKME
      yeteneğiyle (`EventHotKeyRef` haritası) — **node-gyp ve postinstall derlemesi kalktı**
- [x] `claim`/`release` yönlendirmesi (native mi Tauri mi), dize üzerinden
- [x] `RESERVED_KEYS` koruması + kalıcı bağlama sanitizasyonu — gerçek `config.json`'a
      `Cmd+C` yazılarak uçtan uca doğrulandı: tespit → `Alt+9`'a dönüş → diske yazma → toast
- [x] Menü açıkken askıya alma / geri alma
- [x] Başarısız kayıt için toast, Hızlı Yapıştır için 3 sn gecikmeli uyarı

**2.5 Otomatik başlatma** ✅
- [x] `tauri-plugin-autostart` (`--hidden` argümanıyla), açılışta OS durumuyla eşitleme,
      OS reddederse tercihi geri alma

**Kabul kriteri — karşılandı:** Kopyalanan metin geçmişe düşüyor (uçtan uca doğrulandı),
**parola yöneticisi içeriği düşmüyor** (`NSPasteboard`'a gerçek `ConcealedType` yazan bir
testle doğrulandı), tepsi simgesi ve menüsü çalışıyor, kullanıcının yedi özel kısayolu
göç sonrası kaydoldu.

### Faz 3 — Ekran alıntısı, OCR, renk seçici ✅ TAMAMLANDI

**3.1 Yakalama servisi** ✅
- [x] `capture/screenshot.rs`: `xcap`, monitör başına YEREL çözünürlük, 3 denemeli
      boş-kare retry (Electron'un 5'i hafifletildi — Spike-3'te hiç boş kare çıkmadı,
      ama tek makinedeki tek ölçüm GPU çeşitliliğini kapatmaz)
- [x] `platform/macos/permissions.rs`: `CGPreflightScreenCaptureAccess` +
      Sistem Ayarları'na yönlendirme
- [x] Overlay'ler ÖNCE açılıyor, yakalama paralel yürüyor; `CONCURRENCY = 2`

**3.2 Overlay pencereleri** ✅
- [x] `windows/capture.rs`: monitör başına tam ekran, `pop-up-menu` seviyesi,
      video/kaydırma için `content_protected`
- [x] **Kare teslimi ÇEKME modeli**: ana süreç metadata itiyor, renderer kareyi
      `take_capture_frame` ile çekiyor (`ipc::Response` → ham bayt). `emit` JSON
      serialize ettiği için 3,6 MB'lık PNG ~15 MB'lık sayı dizisine dönerdi.
- [x] `snip_ready`, `capture_retry` (2 deneme), `capture_claim_monitor`

**3.3 Çıktı yolları** ✅
- [x] `snip_copy_image` / `snip_copy_buffer` (ham PNG), `snip_copy_color`,
      `snip_save_image` / `snip_save_buffer`, tek-panel kilidi
- [x] `gallery.rs`: cover-crop küçük resim (uzun kaydırma yakalamalarının bulaşık
      olmasını engelleyen geometri), 30 kayıt sınırı, sha1 tekilleştirme

**3.4 OCR** ✅
- [x] `ocr.rs`: `tesseract-rs`, eng+tur GÖMÜLÜ, `spawn_blocking`
- [x] Electron'daki ~150 satırlık worker yaşam döngüsü (zaman aşımları, idle release,
      thread ölüm takibi, cachePath tuhaflığı) **tamamen silindi**
- [x] 9,9 MB'lık `.traineddata` dosyaları `extraResources`'tan çıktı

**Kabul kriteri — karşılandı:** İki monitörde overlay açılıyor, yakalanan görüntü
büyüteçle piksel örnekleniyor (`#1e1d1e` okundu), OCR gömülü eng+tur ile init oluyor.

### Faz 4 — Video kaydı ve kaydırmalı yakalama ✅ macOS TAMAM · ⚠ Windows açık

**4.1 Video (macOS)** ✅
- [x] `capture/recorder.rs`: ScreenCaptureKit + `SCRecordingOutput` → H.264/mp4
- [x] `sourceRect` ile kırpma, **`with_captures_audio` ile sistem sesi** (BlackHole yok),
      `with_captures_microphone` ile mikrofon
- [x] Overlay `excluding_windows` ile akıştan dışlanıyor (ikinci hat: `content_protected`)
- [x] İptalde geçici dosyanın yolu panoya kopyalanıyor — kayıt kaybolmuyor
- [x] **Entegre test:** 1280×720 @30fps, sistem sesi açık, 5 sn → geçerli mp4
      (QuickLook çözdü)

**4.2 Video (Windows)** ⚠ **AÇIK** — bkz. aşağıdaki dürüst durum

**4.3 Recorder UI uyarlaması** ✅
- [x] `recorder.js`'ten `getUserMedia` + canvas kırpma + `MediaRecorder` + saniyede bir
      `record-chunk` IPC'si **tamamen çıkarıldı** (~180 satır). Kareler webview'a HİÇ
      uğramıyor.
- [x] Ses yardımcıları (`getMicTrack`, `getSystemAudioTrack`, `mixAudioTracks`,
      `stopAudioCapture`, `systemAudioUnavailableMsg`) silindi — ses artık Rust'ta
- [x] UI (seçim, araç çubuğu, sayaç, tıklama geçirgenliği) aynen korundu

**4.4 Kaydırmalı yakalama** ✅ macOS
- [x] `capture/scroll_stream.rs`: `Channel<Raw>` ile **ham RGBA**, 15 fps, ZATEN KIRPILMIŞ
- [x] `scroller.js`: `getUserMedia` bloğu kanal aboneliğiyle değiştirildi;
      `sampleFrame` artık kırpma/ölçek hesabı yapmıyor, geleni `putImageData` ile basıyor
- [x] **`stitcher.js` ve testi HİÇ değişmedi** (Spike-5: 234 MB/sn, sıfır kare düşümü)
- [x] `scroll_begin` diğer overlay'leri kapatıp global Escape'i kuruyor, `scroll_end` bırakıyor

#### ⚠ Bilinen sınırlar — dürüst durum

| Konu | Durum |
|---|---|
| **Windows video + kaydırma** | **Yazılmadı.** `windows-capture` + Media Foundation gerekiyor. Bu makinede test edilemediği için körlemesine FFI yazmak yanlış güven verirdi. Komutlar Windows'ta temiz bir "bu platformda henüz taşınmadı" hatası veriyor. |
| **Bitrate kontrolü** | `SCRecordingOutput` bitrate ayarı sunmuyor. Kalite kademesi ÇÖZÜNÜRLÜK üzerinden (1.0×/0.75×/0.5×). İnce kontrol `objc2-av-foundation` + `AVAssetWriter` ile gelir. |
| **Asgari macOS** | `SCRecordingOutput` **15.0+** ister. Uygulamanın geri kalanı 12.3'te çalışıyor; video kaydı daha eskide devre dışı. 12.3'e indirmek yine `AVAssetWriter` yolunu gerektiriyor. |

### Faz 5 — Galeri, görüntüleyici, widget, hızlı yapıştır, güncelleyici ✅ TAMAMLANDI

> Faz 4'ten ÖNCE yapıldı: uygulamanın kalan yüzeyinin çoğunu bu açıyor.

**5.1 Galeri** ✅ · **5.2 Görüntüleyici** ✅ (dinamik boyut, ←/→, şerit, karşılaştırma,
düzenlenmiş kopya, maximize-taşma inset hesabı) · **5.3 Widget** ✅ (ölçekli ölçüler,
düğme↔pencere koordinat ayrımı, snap, göreli konum, 10 sn topmost) ·
**5.4 Hızlı yapıştır** ✅ (`focusable:false`, imleç yanı, görünürken global Esc,
**`CGEventPost` — Automation izni GEREKMİYOR**, Windows'ta `SendInput` — PowerShell
süreci kalktı) · **5.5 Güncelleyici** ✅ (macOS'ta manuel indirme politikası korundu)

**Kabul kriteri — karşılandı:** Görüntüleyici gerçek bir yakalamayı açtı (başlıkta
boyut/tarih/boyut, araç çubuğu, şerit). Widget mor düğmesiyle şeffaf render oldu.

### Faz 6 — Paketleme, imzalama, CI, veri göçü ✅ macOS TAMAM

- [x] `tauri.conf.json` bundle: identifier, ikonlar, kategori, publisher, lisans
- [x] `src-tauri/Info.plist`: `NSScreenCaptureUsageDescription`,
      `NSMicrophoneUsageDescription`, `LSUIElement`, minimum 12.3.
      **`NSAppleEventsUsageDescription` KASITLI OLARAK YOK** — `CGEventPost`
      Automation izni istemiyor.
- [x] Windows NSIS: `currentUser`, `downloadBootstrapper` (WebView2)
- [x] `.github/workflows/release.yml` → `tauri-action`, 3 platform matrisi,
      `Swatinem/rust-cache`, cmake doğrulaması, `includeUpdaterJson`
- [x] `SIGNING.md` ve `RELEASE_GUIDE.md` yeniden yazıldı
- [x] `package.json`: `postinstall` node-gyp derlemesi ve `node-addon-api`/`node-gyp`
      bağımlılıkları **kaldırıldı** — native eklenti Rust'a taşındı
- [x] **Release yapısı doğrulandı:** `CopyBoard.app` üretildi, çalıştırıldı, ayakta kaldı

#### Ölçülen boyut

| | Electron v2.12.0 | Tauri v3.0.0 | |
|---|---:|---:|---|
| macOS `.app` | **305 MB** | **36 MB** | **8,5× küçük** |

- [ ] Windows paketi — bir Windows makinesinde/CI'da doğrulanmalı
- [ ] Güncelleyici anahtar çifti — `npx tauri signer generate` (özel anahtar depoya girmez)

### Faz 7 — Beta, hata kapatma, geçiş (2 hafta)

- [ ] v3.0.0-beta.1 yayını (yan yana kurulabilir: `productName: CopyBoard Beta`, farklı `identifier`)
- [ ] Electron ↔ Tauri **karşılaştırma matrisi** (§10) tamamen yeşil
- [ ] v2.12.x için son bir Electron sürümü: kullanıcıyı v3'e yönlendiren bir bildirim (§8.3)
- [ ] `src-electron-legacy/`, `native/`, `eng.traineddata`, `tur.traineddata`, `electron*` bağımlılıkları **silinir**
- [ ] README, CHANGELOG, ekran görüntüsü üretme script'i (`scripts/capture-screens.js` → Tauri karşılığı)
- [ ] v3.0.0 yayını

---

## 8. Veri Göçü

### 8.1 Yol değişikliği

| | Electron | Tauri |
|---|---|---|
| macOS | `~/Library/Application Support/copyboard/config.json` | `~/Library/Application Support/com.nurullahyayan.copyboard/config.json` |
| Windows | `%APPDATA%\copyboard\config.json` | `%APPDATA%\com.nurullahyayan.copyboard\config.json` |
| Ekran görüntüleri | `.../copyboard/screenshots/*.png` | `.../com.nurullahyayan.copyboard/screenshots/*.png` |

### 8.2 Göç algoritması (`migrate.rs`, ilk çalıştırmada bir kez)

```
1. Tauri config.json zaten varsa → çık (göç yapılmış)
2. Electron dizinini bul (platforma göre, sabit yol)
3. config.json yoksa → çık (temiz kurulum)
4. config.json'u OKU, doğrula (serde ile Store yapısına parse)
5. screenshots/ dizinini KOPYALA (taşıma DEĞİL)
6. screenshots[].file yollarını yeni dizine göre YENİDEN YAZ
7. widgetDockParams.displayId → monitör adına dönüştür (§4.3), 
   dönüştürülemezse alanı düşür (ensureWidgetInBounds zaten kurtarır)
8. Yeni config.json'u atomik yaz
9. migratedFrom: "electron-2.12.0" alanını ekle (idempotans + telemetri)
10. Electron dizinine DOKUNMA → v2'ye geri dönüş her an mümkün
```

**Kritik kural: kopyala, taşıma.** Kullanıcı v3'ten memnun kalmazsa v2.12.0'ı yeniden kurup kaldığı yerden devam edebilmeli.

### 8.3 Sürüm geçişi (kullanıcıya ulaşma)

Electron'un `electron-updater`'ı Tauri paketini kuramaz. İki seçenek:

**Seçenek 1 (önerilen) — "son Electron sürümü" köprüsü:**
v2.12.1 yayınlanır; içeriği yalnızca güncelleme diyaloğunu değiştirir: "CopyBoard 3.0 yeni bir altyapıya geçti, bir kez elle indirmeniz gerekiyor" + GitHub release bağlantısı + `shell.openExternal`. Windows'ta NSIS kurulumu eski sürümün üzerine kurulur (aynı `appId`), macOS'ta `.app` değiştirilir.

**Seçenek 2 — sessiz geçiş:** v2.12.1'in updater'ı Tauri NSIS `.exe`'sini indirip çalıştırır (`autoUpdater` yerine elle indirme + `shell.openPath`). Daha az sürtünme ama daha riskli; Windows'a özel.

Karar: **Seçenek 1.** macOS zaten elle indiriyor; Windows kullanıcısı için tek seferlik bir tıklama kabul edilebilir.

---

## 9. Paketleme, imzalama, CI

### 9.1 Beklenen boyutlar

| | Electron v2.12.0 | Tauri v3.0.0 | Kaynak |
|---|---:|---:|---|
| macOS `.app` | **305 MB** | **36 MB** | ölçüldü |
| Boşta RAM (toplam) | **670 MB** | **252 MB** | ölçüldü |
| Süreç sayısı | 10 | 4 | ölçüldü |
| Windows Setup `.exe` | ~85 MB | ~10 MB (tahmin) | doğrulanmadı |

> **Bellek tahmini yanlıştı.** Plan başta "60–120 MB" diyordu; gerçek 252 MB. Sebep:
> uygulama açılışta ÜÇ webview kuruyor (ana pencere, önceden hazırlanan hızlı yapıştır,
> widget) ve WKWebView her biri için ayrı bir içerik süreci açıyor. Kazanç yine de
> **2,7 kat** — ama 5 kat değil. Tek webview'lı bir uygulama için o tahmin doğru olurdu;
> CopyBoard öyle bir uygulama değil.
>
> Not: WKWebView içerik süreçleri sistem tarafından yönetiliyor ve bir kısmı paylaşımlı
> olabilir, yani bu ölçüm yaklaşıktır.

`tesseract-rs` gömülü eng+tur (~10 MB) bu rakamlara dahildir ve `extraResources`'tan çıktığı için net kazanç sağlar.

### 9.2 CI (`.github/workflows/release.yml`)

```yaml
- uses: dtolnay/rust-toolchain@stable
- uses: Swatinem/rust-cache@v2
  with: { workspaces: './src-tauri -> target' }
- uses: tauri-apps/tauri-action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_KEY_PASSWORD }}
  with:
    tagName: v__VERSION__
    releaseDraft: true
    includeUpdaterJson: true
```

**Matrix (Faz L sonrası):**
```yaml
matrix:
  include:
    - { os: macos-latest,   args: '--target aarch64-apple-darwin' }
    - { os: macos-13,       args: '--target x86_64-apple-darwin' }
    - { os: windows-latest, args: '' }
    - { os: ubuntu-22.04,   args: '' }   # 22.04: WebKitGTK 4.1 + eski glibc uyumu
```
Linux runner'ında sistem bağımlılıkları: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, `patchelf`, `libpipewire-0.3-dev`.

**Not:** Mevcut `max-parallel: 1` kısıtı gerekmez — `tauri-action` aynı taslak release'e güvenle ekler.

**İlk build uyarısı:** `tesseract-rs` Tesseract+Leptonica'yı kaynaktan derler. Cache'siz macOS runner'da ~12 dk, Windows'ta ~18 dk. `rust-cache` ile sonraki build'ler ~3 dk.

### 9.3 İmzalama

- **Tauri updater imzası:** zorunlu, `tauri signer generate` (Apple/Microsoft ile ilgisi yok)
- **macOS kod imzası:** bugünkü gibi ad-hoc (`identity: null`) → Gatekeeper uyarısı devam eder, `SIGNING.md` güncellenir
- **Windows kod imzası:** bugünkü gibi imzasız (`forceCodeSigning: false`); `scripts/generate-pfx-and-secrets.ps1` Tauri'nin `windows.certificateThumbprint` ayarına uyarlanır

---

## 10. Test Stratejisi

### 10.1 Otomatik

| Ne | Nasıl |
|---|---|
| `stitcher.js` algoritması | Mevcut `test/stitcher.test.mjs` — **değişmeden çalışmalı** |
| Accelerator çevirici | Mevcut `test/accelerator.test.mjs` + yeni Rust `#[test]` (Electron string ↔ `Shortcut` round-trip) |
| `store.rs` | Rust `#[test]`: yükleme, sanitizasyon, debounce, atomik yazma, bozuk JSON kurtarma |
| `migrate.rs` | Rust `#[test]`: gerçek `config.json` fixture'ı (307 geçmiş, 30 görüntü) ile |
| Thumbnail geometrisi | Rust `#[test]`: `thumb_size_for()` — 766×8175 gibi uç oranlar |
| Gizli pano tespiti | Manuel (1Password/Bitwarden ile) |

### 10.2 Karşılaştırma matrisi (Electron ↔ Tauri, her platform)

Faz 7 kapısı. Her satır **iki sürümde yan yana** doğrulanır:

```
[ ] Kopyala → geçmişe düşüyor, 1sn içinde
[ ] Parola yöneticisinden kopyala → geçmişe DÜŞMÜYOR
[ ] Geçmiş 500+ öğe → liste akıcı, arama anlık
[ ] Favori ekle/çıkar/not/sürükle-sırala → kalıcı
[ ] Geçmiş temizle → favoriler duruyor
[ ] 7 global kısayolun her biri → tetikleniyor
[ ] Türkçe-Q klavye Cmd+" → tetikleniyor (macOS)
[ ] Kısayol çakışması → toast, eski binding geri geliyor
[ ] Tepsi menüsü açıkken kısayol → menüden çalışıyor, kapanınca patlama YOK
[ ] Alıntı: tek monitör / 2 monitör / farklı DPI → keskin
[ ] Alıntı: kalem, kare, daire, ok, metin, blur, kırp
[ ] Alıntı: kopyala (piksel boyutu doğru) / kaydet (panel öne geliyor)
[ ] ESC herhangi bir monitörden → tüm overlay'ler kapanıyor
[ ] OCR: Türkçe metin / İngilizce metin / karışık → panoya + geçmişe
[ ] Renk seçici: büyüteç, C tuşu, hex panoya
[ ] Video: tam ekran / bölge, mikrofon aç-kapa, sistem sesi aç-kapa
[ ] Video: kalite yüksek/orta/düşük → dosya boyutu farkı
[ ] Video: kayıt sırasında toolbar hover → etkileşim çalışıyor
[ ] Video: iptal → temp yolu panoya
[ ] Kaydırmalı: 5000px sayfa → tek görüntü, yapışkan başlık tekrarlanmıyor
[ ] Kaydırmalı: çok hızlı kaydırma → uyarı + atlanan kare raporu
[ ] Kaydırmalı: ESC ile iptal (overlay tıklama-geçirgenken)
[ ] Galeri: 30 kayıt, 1/2 sütun, thumbnail keskin (uzun scroll dahil)
[ ] Görüntüleyici: aç, ←/→, filmstrip, çiz, kırp, kopyala
[ ] Karşılaştırma: 2–5 resim, yatay/2'li/4'lü, panel sürükle, ayrı/toplu zoom
[ ] Widget: 4 köşeye yapışma, sürükleme, monitörler arası geçiş
[ ] Widget: renk/saydamlık/boyut ayarı anında uygulanıyor
[ ] Widget: gömülü pano paneli yukarı/aşağı açılıyor
[ ] Hızlı Yapıştır: TextEdit/Notepad'e doğrudan yapıştırma
[ ] Hızlı Yapıştır: widget'tan açınca doğru uygulamaya gidiyor (macOS)
[ ] Tema: koyu/açık/sistem → tüm pencereler, titreme YOK
[ ] Dil: TR/EN → tüm pencereler + tepsi menüsü
[ ] Monitör tak/çıkar → widget kayboluyor mu?
[ ] Uyku/uyanma → pano izleyici devam ediyor
[ ] Otomatik başlangıç → --hidden ile açılıyor, pencere görünmüyor
[ ] Güncelleme: kontrol / indir / kur (Windows), manuel yönlendirme (macOS)
[ ] İlk çalıştırma: Electron verisi göç ediyor, hiçbir şey kaybolmuyor
```

---

## 11. Geri Dönüş Planı

| Aşama | Geri dönüş |
|---|---|
| Faz 1–6 | `src-electron-legacy/` bozulmadan duruyor → `npm run start:electron` |
| Faz 7 beta | Beta ayrı `identifier` ile kurulu, v2.12.0 silinmemiş |
| v3.0.0 sonrası | Electron verisi **kopyalandı, taşınmadı** → v2.12.0 yeniden kurulabilir |
| Kritik hata | GitHub release'de v2.12.0 varlıkları durur; v3 release'i `draft`'a alınır |

---

## 12. Takvim

```
Hafta  1-1.5 : Faz 0  Spike'lar (S1-S8 çekirdek, S9-S11 Linux)   [GEÇ/KAL KAPISI]
Hafta  2-3   : Faz 1  İskelet + pencereler
Hafta  4-5   : Faz 2  Pano + tepsi + kısayollar
Hafta  6-7   : Faz 3  Alıntı + OCR + renk
Hafta  8-12  : Faz 4  Video + kaydırmalı                          ⚠ en riskli
Hafta 13-14  : Faz 5  Galeri + widget + hızlı yapıştır + güncelleyici
Hafta 15-16  : Faz 6  Paketleme + CI + göç
Hafta 17-18  : Faz 7  Beta + geçiş  →  v3.0.0 (macOS + Windows)
Hafta 19-22  : Faz L  Linux (X11 tam, Wayland kısmi)  →  v3.1.0
```

Faz 4 iki haftaya kadar kayabilir; diğer fazların paralel yürüyecek işi yoktur (tek geliştirici).
Faz L ayrı bir sürüm olarak konumlandırıldı (§5.14) — çekirdek göçün riskine eklenmiyor.

---

## 12.1 Doğrulanmış API Notları

Bu plandaki Tauri API iddiaları `docs.rs/tauri` üzerinden doğrulandı (2026-08-30):

| İddia | Durum |
|---|---|
| `WebviewWindowBuilder`: `focusable`, `transparent`, `decorations`, `always_on_top`, `skip_taskbar`, `shadow`, `visible`, `background_color`, `content_protected`, `initialization_script`, `visible_on_all_workspaces`, `inner_size`, `position` | ✅ Hepsi mevcut |
| `set_zoom` builder'da **yok** — `Webview`/`WebviewWindow` üzerinde | ✅ Doğrulandı |
| `Monitor::work_area()` mevcut, `PhysicalRect` döner | ✅ Doğrulandı |
| `global-hotkey` crate'i `Code::IntlBackslash` → macOS keycode eşlemesi **yapmıyor** | ✅ Kaynak koddan doğrulandı → Carbon FFI zorunlu |
| WKWebView'da `getDisplayMedia` / `chromeMediaSource` **yok** | ✅ Doğrulandı → §5.1 |
| `tesseract-rs` varsayılan olarak eng+tur verisini gömüyor | ✅ Doğrulandı |
| `tauri-plugin-updater` imzasız güncelleme kabul etmiyor | ✅ Doğrulandı |

**Faz 0'da ölçülerek doğrulanacak (henüz iddia değil, varsayım):**
`focusable(false)` macOS odak davranışı · `set_ignore_cursor_events` Windows fare-iletimi · WebView2 şeffaflık · `visible_on_all_workspaces` + fullscreen · `xcap` çok-DPI kalitesi · Channel kare akışı verimi · `initialization_script` çalışma sırası.

---

## 13. Açık Kararlar

| # | Karar | Seçenekler | Öneri |
|---|---|---|---|
| K1 | Video çıktı formatı | `.mp4` (H.264/AAC) · `.webm` (yeniden encode) | **`.mp4`** — yerel encoder, daha uyumlu |
| K2 | Video mimarisi | Yerel Rust encoder · ffmpeg sidecar | **Yerel** (Spike-4 karar verir) |
| K3 | OCR motoru | `tesseract-rs` gömülü · gizli webview + tesseract.js | **`tesseract-rs`** |
| K4 | Kaydırmalı birleştirme | JS'te kalsın · Rust'a portla | **JS'te kalsın** (Spike-5 karar verir) |
| K5 | Sürüm numarası | v3.0.0 · v2.13.0 | **v3.0.0** — kırıcı altyapı değişikliği |
| K6 | Geçiş yöntemi | Elle indirme köprüsü · sessiz updater | **Elle indirme** (§8.3) |
| K7 | Linux desteği | ~~Şimdi~~ · **Kapsama alındı** | ✅ **Karar verildi: dahil.** Faz L olarak v3.1.0'da, X11 tam / Wayland kısmi (§5.14) |
| K9 | Wayland'da pano izleme (GNOME) | Sessizce çalışmasın · Kullanıcıya söyle + elle ekleme kısayolu | **Söyle** — sessiz başarısızlık en kötü seçenek |
| K10 | Linux paket formatı | AppImage · deb · rpm · Flatpak | **AppImage + deb** (Tauri yerleşik); Flatpak portal uyumu zaten gerektiği için sonradan kolay |
| K8 | macOS kod imzası | Ad-hoc devam · Apple Developer ($99/yıl) | **Ayrı iş kalemi** — updater'ın macOS'ta açılması buna bağlı |
