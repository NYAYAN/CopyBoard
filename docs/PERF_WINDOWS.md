# Electron ↔ Tauri performans karşılaştırması (Windows)

Tarih: 2026-09-03. Makine: Windows 11 Pro, 16 mantıksal çekirdek, 1920×1200 tek monitör.
Eski: kurulu Electron v2 (`C:\Program Files\CopyBoard`, Electron 39) ve aynı sürümün kaynaktan
çalıştırılan hâli (main dalı, zamanlama günlükleri eklenmiş). Yeni: `src-tauri` release derlemesi
(debug yalnız `--record-test` için; işaretli). Kısayollar ikisinde de aynı (Alt+9 ekran görüntüsü).

## Sonuç tablosu

| Ölçüm | Electron v2 | Tauri | Yöntem |
|---|---|---|---|
| Açılış → ilk görünür pencere | 1958 ms (ılık), 3034 ms (soğuk) | **359 ms** (release), 1499 ms (debug) | `EnumWindows` + `IsWindowVisible`, 25 ms örnekleme |
| Boşta bellek (süreç ağacı toplamı) | 6 süreç, WS 600–649 MB, Private 334–387 MB | 9 süreç, WS 597 MB, Private 308 MB (release) | `Get-Process` WorkingSet/Private, 12 sn sonra |
| Boşta CPU (10 sn) | %2–8 | %3,4 (release), %4,2 (debug) | `TotalProcessorTime` farkı |
| Ekran görüntüsü: yakalama + PNG (1 monitör) | **239 ms** medyan (getSources 165 + toPNG 74), PNG 313 KB | **32,9 ms** medyan (ilk 44), PNG 803 KB | Electron: `bench-electron.js`; Tauri: `copyboard.exe --shot-test` (12 tur) |
| Ekran görüntüsü: Alt+9 → görüntü ekranda boyandı | **715–915 ms** (medyan ~760) | **169–199 ms** (medyan ~178; kare teslim +112–152) | Uygulama içi `PERF` günlükleri: yakalama başlangıcı → renderer `snip-painted` (rAF sonrası) |
| Video kaydı 1280×720, ultra, mikrofon + sistem sesi | ölçülemedi (yalnız arayüzden başlıyor); MediaRecorder VP9 **yazılım** kodlama, 60 fps, 50 Mbps, renderer'da canvas `drawLoop` | H.264 (Media Foundation, donanım dönüşümleri açık) + AAC, 30 fps, 16 Mbps: **tek çekirdeğin %19'u (toplamın ~%1,2'si), 158 MB sabit**, 37 MB / 20 sn | `--record-test=ultra,20` (debug), 4 sn'de bir WS + CPU |
| Kurulum boyutu | 374 MB | 34 MB exe (+ sistemdeki paylaşılan WebView2) | `du`, dosya boyutu |

## Okuma

- **Ekran görüntüsü**: Electron'da `desktopCapturer.getSources` yerel çözünürlükte ~165 ms, üstüne
  `toPNG` ~75 ms; uçtan uca kullanıcı karartmayı ~0,75 sn sonra görüyor (overlay penceresi hemen
  açılıyor ama saydam; görüntü gelince doluyor). Tauri'de aynı iş `xcap` + `png` ile ~33 ms (7 kat),
  uçtan uca ~180 ms (4 kat; kullanıcı karartmayı yarım saniye daha erken görüyor). Overlay hazır olmadan gösterilmiyor (`visible: false` → `show()`),
  yani Tauri'de "pencere göründü" = "görüntü ekranda".
- **Video**: Electron yolu ekranı `getUserMedia` ile alıp canvas'a kırpıp `MediaRecorder`'a
  veriyor; kodlama VP8/VP9 yazılımda, renderer süreci içinde. Tauri yolu WGC karelerini doğrudan
  Media Foundation H.264 kodlayıcısına yazıyor; ölçülen CPU tek çekirdeğin beşte biri. Electron
  tarafı bu makinede ölçülmedi (kayıt yalnız arayüz akışıyla başlıyor); karşılaştırma mimariden.
  Çıktı biçimi de değişti: webm (VP9) → mp4 (H.264 + AAC), her oynatıcıda açılıyor.
- **Bellek**: Boşta neredeyse eşit. WebView2 de Chromium; Tauri tarafında pencere başına ayrı
  WebView2 süreçleri var (8 adet), Electron'da 6 süreç. Kazanım bellekte değil, açılış ve yakalama
  yollarında.
- **Açılış**: 5 kat hızlı (359 ms ↔ 1958 ms).
- **PNG boyutu**: Tauri'nin PNG'si daha büyük (803 KB ↔ 313 KB): `png` kasası hızlı sıkıştırma
  düzeyinde, Electron `toPNG` daha sıkı sıkıştırıyor. Kare yalnız overlay'e IPC ile gidiyor,
  diske bu hâliyle yazılmıyor; hız tercih edildi.
- **Sonraki adım (isteğe bağlı)**: Tauri'de yakalama iş parçacığı overlay pencereleri
  oluşturulduktan SONRA başlıyor; yakalama 33 ms sürerken teslim +120 ms'de. Yakalamayı pencere
  oluşturmadan önce başlatmak uçtan ucayı ~100 ms'ye indirebilir.

## Yöntem notları / tuzaklar

- İki overlay de `WDA_EXCLUDEFROMCAPTURE` ile işaretli; `GetPixel`/`BitBlt` ile ekrandan
  karartmayı yakalamak MÜMKÜN DEĞİL (piksel hiç değişmiyor). O yüzden uçtan uca ölçüm uygulama
  içi günlüklerle: Tauri `capture::begin` anı → `PERF kare teslim +ms` → renderer
  `sendDebugLog('snip-painted')` → `PERF snip-painted +ms` (`copyboard.log`). Electron'da aynı
  noktalar `[PERF]` satırlarıyla stdout'a (kaynaktan, `scratchpad/electron-main` worktree'si,
  `node_modules` junction ile; `electron.exe <worktree>`).
- "İlk görünür pencere" Electron için ADİL DEĞİL: overlay saydam açılıyor (25 ms), görüntü sonra
  geliyor. Yalnız açılış süresinde kullanıldı.
- `--record-test` yalnız debug derlemede var; video CPU'su debug ile ölçüldü. Kare kopyalama
  dışında iş MF/WGC'de (yerel), debug/release farkı küçük.
- Ölçüm sırasında derleme çalıştırma: CPU rekabeti gecikmeyi bozar (ilk denemede yaşandı).
