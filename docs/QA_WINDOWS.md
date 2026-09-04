# Windows QA — Tauri sürümü (2026-09-02)

Bu belge, Tauri portunun Windows'ta uçtan uca kontrolünün kaydıdır: ne sınandı, ne
bulundu, ne düzeltildi, ne bekliyor. Kontroller üç katmanda yapıldı:

1. **`--qa` kendini-sınama** (`src-tauri/src/qa.rs`, yalnız debug derlemesi): Rust
   tarafındaki akışları komut işleyicileri üzerinden çalıştırır, sonucu pencere/pano
   durumundan okur. Çalıştırma: `scripts\win-env.cmd npx tauri dev -- -- --qa`, sonuç
   `%LOCALAPPDATA%\com.nurullahyayan.copyboard\logs\copyboard.log` içinde `QA ✓/✗`.
2. **Win32 gözlemi**: `EnumWindows`/`IsWindowVisible`/`WindowFromPoint`/`Process.Responding`
   ile gerçek pencere durumu; sentetik tıklama/klavye ile gerçek kullanıcı yolu.
3. **Kod okuması**: renderer → `api-tauri.js` → komut zinciri.

## Kök neden: ana thread kilitlenmesi (DÜZELTİLDİ)

Kullanıcı raporları — "Tümü'den kopyalama kopyalandı diyor ama panoya yazmıyor",
"Büyük Görüntüle çalışmıyor", "simge durumuna küçültme çalışmıyor", "widget kapat/aç
sonrası geri gelmiyor" — tek bir nedene indi: Windows olay günlüğünde
`Application Hang (AppHangB1)` kaydı (15:24:10), süreç `0xCFFFFFFF` ile sonlandırıldı.

Senkron `#[tauri::command]`lar WebView2'nin mesaj geri çağrısının içinde, ana thread'de
koşuyor; orada `hide()/show()/minimize()/set_focus()` gibi eşzamanlı pencere çağrıları
kilitleniyor. WebView2 kendi sürecinde çizmeye devam ettiği için pencere "canlı"
görünüyor ama hiçbir tıklama işlenmiyor — tam olarak raporlanan tablo.

**Düzeltme:** pencereye dokunan 50 komut `async fn` yapıldı (`commands/*.rs`,
`capture/mod.rs`); `Request<'_>` alan iki tampon komutu işi `async_runtime::spawn` ile
devrediyor; kural `commands/mod.rs` başında. Doğrulama: gerçek tıklama → pano değişti,
`Process.Responding=True`, pencere gizlendi.

## İkinci kök neden: kısayol işleyicisinde kilit (DÜZELTİLDİ)

"Hızlı yapıştırı açıp bir şey seçince donuyor" raporu ikinci bir `AppHangB1` kaydıyla
(15:59:53) geldi. Log seçicinin yerleştiğini gösteriyor, sonrası yok. Neden:
`tauri-plugin-global-shortcut` kısayol işleyicimizi kendi `shortcuts` Mutex'ini
tutarken çağırıyor; işleyicinin içinde `quickpaste::show` Escape'i **kaydediyor** ve
aynı kilidi ikinci kez almaya çalışıyor. Seçici WebView2 tarafından çizildiği için
"açılmış" görünüyor ama ana thread ölü; ilk tıklama hiçbir şey yapmıyor.

Düzeltme: kısayol işleyicileri artık hiçbir işi doğrudan yapmıyor;
`shortcuts::defer_to_main` ile ana thread'e ertelenmiş mesaj bırakıyor (işleyici
döndükten, kilit bırakıldıktan sonra koşar). Aynı kalıp seçicinin ve kaydırma
evresinin Escape işleyicilerinde. Doğrulama: gerçek Ctrl+Shift+V → seçici → satıra
tıklama → pano değişti, seçici kapandı, süreç yanıt verir kaldı.

Hata ayıklama derlemesine bir **ana thread bekçisi** eklendi (`dbgtrace.rs`): 3 sn
yanıt yoksa loga `bekçi: ANA THREAD YANIT VERMİYOR` yazar; bir daha saatlerce kör
kalınmasın.

## Üçüncü kök neden: widget'ın kaybolması (DÜZELTİLDİ)

`show_inactive` ham `ShowWindow(SW_SHOWNOACTIVATE)` çağırıyordu; tao kendi bayrak
önbelleğinde pencereyi "görünmez" bildiği için ilk bayrak değişiminde (`hit-test`
geçirgenlik geçişi) `SW_HIDE` gönderiyordu. Widget ~1 sn sonra sessizce yok oluyordu.
Düzeltme: `set_focusable(false)` → `show()` → `set_focusable(true)` (tao yolundan).

## Kontrol listesi

| # | Akış | Yöntem | Sonuç |
|---|------|--------|-------|
| 1 | Derleme (`cargo check --all-targets`) | win-env | ✓ temiz |
| 2 | Rust testleri (`cargo test`) | win-env | ✓ 72/72 |
| 3 | JS testleri (`npm test`) | node | ✓ 52/52 |
| 4 | Electron verisi göçü | log | ✓ 400 geçmiş, 8 favori, 30 görüntü; kaynak dizine dokunulmadı |
| 5 | Global kısayollar (7) | log | ✓ Electron kapalıyken 7/7 kayıtlı; Electron açıkken 0/7 ("başka uygulama almış" uyarısı doğru) |
| 6 | Kopyalama `copy_text` → pano | --qa | ✓ |
| 7 | Renderer → IPC → `copy_text` → pano | --qa (eval) | ✓ |
| 8 | Listeden gerçek tıklama → pano + gizlenme + yanıt verirlik | Win32 tıklama | ✓ (async düzeltmesi sonrası) |
| 9 | Geçmişe ekleme / favori ekle-kaldır | --qa | ✓ |
| 10 | Ana pencere show/hide, Alt+V | --qa + keybd | ✓ görünür kalıyor, blur'da gizleniyor |
| 11 | Widget kapat / aç | --qa | ✓ (show_inactive düzeltmesi sonrası) |
| 12 | Widget hit-test geçişi sonrası görünürlük | --qa | ✓ |
| 13 | Hızlı yapıştır aç / kapa | --qa | ✓ |
| 13b | Hızlı yapıştır: gerçek Ctrl+Shift+V → satıra tık → pano + kapanma + yanıt verirlik | Win32 | ✓ (defer_to_main düzeltmesi sonrası) |
| 14 | Toast göster + `toast_resize` | --qa + Win32 | ✓ (uzun mesajda 160 px) |
| 15 | Görüntüleyici aç / küçült / büyüt / ileri / kapat | --qa | ✓ |
| 16 | Yakalama overlay'i (draw): kur, kare teslimi, görünür, kapat, widget geri, bayrak | --qa | ✓ |
| 17 | Video kaydı (WGC kare + kendi MF Sink Writer: H.264 + AAC → mp4) | --qa, cv2 | ✓ 30 fps, yön doğru (0.995/0.011), `avc1`+`mp4a` izleri |
| 17b | Ses: mikrofon + sistem sesi (WASAPI, loopback), karıştırma | --qa | ✓ 48 kHz float → AAC 201 kbps, 3,1 sn |
| 17c | Kaydırma akışı (WGC → kırpılmış RGBA → Channel) kare sayısı | --qa | ✓ 26–27 kare / 2 sn |
| 17d | Uzun kayıt bellek: `--record-test=ultra,20` sesli, WorkingSet 4 sn'de bir | ölçüm | ✓ 155–158 MB sabit (önce: DISABLE_THROTTLING ile 2,3 GB/30 sn; sessiz loopback'te karıştırıcı ilk paketi bekleyip yazıcıyı tıkıyordu) |
| 18 | OS tema tercihi (kayıt defteri) | --qa | ✓ |
| 19 | Uyku / ekran kapanma bildirimleri | gerçek uyku | ✓ "ekran kapandı → yoklama durdu → uyanıldı → sürdü" |
| 20 | Pencere konumları Electron ile | Win32 | ✓ widget 1509,287 401×65 ve ana 1540,592 birebir |
| 21 | Tema "light" göçü → görüntüleyici açık tema | ekran | ✓ |
| 22 | Olay hedefleme: başka pencereye `emit_to` → bu pencereye sızmamalı; kendi etiketi ve `emit` yayını ulaşmalı (A11 kök nedeni) | --qa 9b-2 | ✓ 3/3 |
| 23 | Kaydırmalı yakalama arayüz akışı: sentetik seçim → Enter (Başlat) → hemen Enter (Bitir) → tekrar Başlat → Bitir (A12) | --qa 9d | ✓ 10/10 — seçim evresine dönüş, akış bırakıldı, yeniden kuruldu, inceleme evresi |
| 24 | Video arayüz akışı: Kayıt düğmesi → RecorderState → arayüz kayıt durumuna geçti (Başlat gizli, Durdur + sayaç görünür) → dosya (A13/B6) | --qa 9e | ✓ 5/5 |
| 25 | Kaydetme paneli: Durdur → sayfa boşaldı, panel açıldı (Win32 `#32770`), ÖNDE, kaydın yapıldığı monitörde; iptalde geçici yol panoya (A14/B6/B7). Süre `COPYBOARD_QA_RECORD_SECS` ile uzatılabilir | --qa 9f | ✓ 6/6 — 60 sn kayıtta (1548 kare, 113 MB) panel Durdur'dan 1305 ms sonra |

## Manuel test bekleyenler (renderer tıklaması gerektirir)

- Galeri: küçük resme tıkla → kopyala; zoom düğmesi → Büyük Görüntüle; sağ tık menüsü;
  Sil; Klasörde Göster. (Komut katmanı `--qa` ile ✓; tıklama yolu async düzeltmesiyle
  aynı mekanizma.)
- Görüntüleyici: çizim + "düzenlenmiş kopyala", karşılaştırma ızgarası.
- Snipper: bölge seç → Kopyala / Kaydet / OCR / renk seçici.
- Ayarlar: tema, dil (sayfa yeniden yükleme), autostart, kısayol değiştirme, widget
  renk/opaklık/ölçek.
- Hızlı yapıştır: Ctrl+Shift+V → seç → hedef uygulamaya yapıştırma (SendInput).
- Güncelleme: "Güncellemeleri Denetle" → `pubkey` boş → uyarı toast'ı.

## Bilinen farklar (tasarım kararı)

- Ana pencerenin dış dikdörtgeni 366×559 (Electron 350×550): çerçevesiz pencereye
  Windows'un eklediği görünmez yeniden boyutlandırma kenarı. İçerik 350×550.
- Video kaydı Windows'ta mp4/H.264 + AAC (mikrofon + sistem sesi WASAPI ile); kalite kademesi
  bit hızına eşleniyor (ultra 16, high 10, medium 5, low 2,5 Mbps).
- Aynı makinede Electron sürümü çalışıyorsa kısayollar ona kalır; tepsi menüsü ve widget
  her zaman çalışır.

## Yeniden çalıştırma

```bat
scripts\win-env.cmd cargo test
scripts\win-env.cmd npx tauri dev -- -- --qa
```
