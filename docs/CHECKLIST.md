# CopyBoard Tauri — Canlı Kontrol Listesi

Tek kaynak. Her kullanıcı talebi buraya girer; her adım işaretlenmeden ilerlenmez.
İşaretler: `[x]` yapıldı ve doğrulandı · `[~]` yapıldı, doğrulama bekliyor · `[ ]` bekliyor.
Doğrulama yöntemi parantez içinde: `--qa` (kendini-sınama), `Win32` (gerçek tuş/tıklama +
pencere sorgusu), `gözle` (kullanıcı), `cv2` (kare analizi).

## A. Kullanıcı bildirimleri

- [x] A1. Yüzen araç (widget) görünmüyor / kapat-aç sonrası gelmiyor — tao bayrak önbelleği, `show_inactive` (`--qa`, Win32)
- [x] A2. Galeride "Büyük Görüntüle" çalışmıyor — senkron komut kilitlenmesi (`--qa`)
- [x] A3. Simge durumuna küçültme çalışmıyor — aynı kilitlenme (`--qa` is_minimized)
- [x] A4. "Tümü"den kopyala: "kopyalandı" diyor ama pano değişmiyor — aynı kilitlenme (Win32 gerçek tıklama)
- [x] A5. Hızlı yapıştır: seçim yapınca donuyor — kısayol eklentisi kilidi, `defer_to_main` (Win32 Ctrl+Shift+V → tık)
- [x] A6. Video ters kaydediyor — MF alttan-üste tampon, satır çevirme eklendi (cv2: `--record-test` 150 kare, normal korelasyon 1.000 / ters 0.111)
- [~] A7. Kaydırmalı yakalama: "Bitir" sonrası Kopyala/Kaydet tıklanamıyor — isabet alanı evre değişiminden ÖNCE bildiriliyordu; `setPhase` artık bildiriyor + isabet testi istemci kökenine alındı (gözle doğrulama bekliyor)
- [x] A8. Windows'ta video kaydı ve kaydırmalı yakalama yok — WGC + Media Foundation ile eklendi (`--qa`: 75 kare/2,9 MB mp4, 26 kare akış)
- [x] A9. Her talep kontrol listesine, kontrollü ilerleme — bu dosya (süreç kuralı, E bölümü güncel)
- [~] A10. Görüntüleyici dar pencerede (uzun kaydırma görüntüsü) araç çubuğu taşıyor, küçült/büyüt/kapat görünmüyor → Çiz/Karşılaştır/Kopyala/Klasör/Sil "…" menüsüne toplanacak, pencere düğmeleri her zaman görünür (gözle)

## B. Video kaydı — kalan işler (Windows)

- [x] B1. Motor: WGC kare + MF H.264 → mp4, 30 fps, bölge kırpma (`--qa`)
- [x] B2. Dikey yön düzeltmesi (A6, cv2)
- [x] B3. Mikrofon sesi — WASAPI yakalama → 48 kHz stereo i16 → MF AAC (`--qa`: "ses [mikrofon]: 48000 Hz, 2 kanal, 32-bit float", mp4'te `mp4a` izi)
- [x] B4. Sistem sesi — WASAPI loopback + mikrofonla karıştırma (`--qa`: "ses [sistem] … 3,1 sn ses", 201 kbps AAC izi)
- [~] B5. Ses/video eşzamanlama — ortak QPC `t0`; gözle (dudak senk./tık sesi) bekliyor
- [x] B5b. Kodlayıcı değişti: kendi Media Foundation Sink Writer. İlk ölçümde yön ters çıktı (satır çevirme bu yolda fazlaydı), çevirme kaldırıldı (cv2: normal 0.995 / ters 0.011, 150 kare = 30 fps, `avc1` + `mp4a` izleri)
- [ ] B6. Kayıt akışının arayüzü: bölge seç → Kayıt → Durdur → kaydetme paneli (gözle)
- [ ] B7. Kaydetme iptalinde geçici dosya yolu panoya (Electron davranışı) — kod var, gözle
- [ ] B8. Çok monitör: doğru monitörden kayıt (`MonitorFromPoint`) — ikinci monitörde gözle
- [ ] B9. Karışık DPI'da kırpma ölçeği (renderer fiziksel piksel veriyor) — %125/%150 ekranda gözle
- [ ] B10. Windows 10 (20348 öncesi) sarı WGC çerçevesi geri dönüşü — bu makinede sınanamaz
- [x] B11. Kalite kademesi → dosya boyutu (5 sn 1280×720 + ses): low 1,2 MB (~2 Mbps), medium 2,4 MB (~4), high 5,1 MB (~8), ultra 8,2 MB (~13) — orantılı (`--record-test=<kalite>,5`)
- [x] B12. Uzun kayıt bellek/CPU — iki hata bulundu ve düzeltildi: (1) `DISABLE_THROTTLING` ile 30 sn'de 2,3 GB → kaldırıldı, sessiz kayıt 145 MB sabit; (2) loopback sessizken karıştırıcı ilk paketi bekleyip hiç ses yazmıyor, yazıcı videoyu tutuyordu → zaman çizgisi t0'dan başlıyor, sessizlik dolduruluyor. Son ölçüm: sesli ultra 20 sn boyunca 155–158 MB sabit, CPU tek çekirdeğin %19'u = 16 mantıksal çekirdekte toplamın ~%1,2'si (`--record-test=ultra,20`)

## C. Kaydırmalı yakalama — kalan işler (Windows)

- [x] C1. Motor: WGC → 15 fps kırpılmış RGBA → Channel (`--qa`)
- [~] C2. Bitir sonrası Kopyala/Kaydet (A7)
- [ ] C3. Uçtan uca: Başlat → kaydır → Bitir → birleştirme → Kopyala/Kaydet → galeri (gözle)
- [ ] C4. Overlay'in kendisinin karelere girmemesi (`WDA_EXCLUDEFROMCAPTURE`) — birleştirilmiş görüntüde çerçeve izi var mı (gözle)
- [ ] C5. 15 fps yeterli mi (hızlı kaydırmada dikiş kaçırma) — gözle

## D. Genel — daha önce doğrulananlar

- [x] D1. Derleme sıfır uyarı, 71 Rust + 52 JS test (2026-09-03, ses modülleri dahil)
- [x] D2. Electron verisi göçü (400/8/30)
- [x] D3. 7 global kısayol (Electron kapalıyken)
- [x] D4. Uyku/ekran kapanma bildirimleri (gerçek uyku)
- [x] D5. Pencere konumları Electron ile birebir
- [x] D6. Renderer → IPC → komut yolu (`--qa` eval)
- [ ] D7. Ayarlar: tema/dil/autostart/kısayol değiştirme (gözle)
- [ ] D8. Snipper: kopyala/kaydet/OCR/renk (gözle)
- [x] D9. Güncelleyici: `pubkey` boş uyarısı — elle kontrol yanıt veriyor, toast görünür (`--qa` 9c); imza anahtarı üretimi kullanıcıda (`SIGNING.md`)
- [x] D10. Commit + push, aynı dal (`tauri-migration`) — 2026-09-03: 4 commit (yakalama motoru, Rust düzeltmeleri + QA araçları, renderer, ikon/betik/belgeler); package-lock.json değişikliği npm sürüm gürültüsüydü, geri alındı
- [x] D12. Electron ↔ Tauri performans karşılaştırması → `docs/PERF_WINDOWS.md`: açılış 1958→359 ms, ekran görüntüsü yakalama+PNG 239→33 ms, Alt+9→boyanma ~760→~180 ms, boşta bellek eşit (~600 MB WS), video CPU tek çekirdeğin %19'u (Electron yazılım VP9, ölçülemedi). Ölçüm araçları: `--shot-test` (release'te de var), `PERF` günlükleri, `scratchpad/bench-electron.js`
- [ ] D11. Dev çıktısında tao uyarısı "PostMessage failed … Invalid window handle" (0x80070578) — kapanan pencereye geç mesaj; zararsız görünüyor, tekrarlarsa incelenecek

## E. Talep günlüğü (kronolojik)

1. Tauri tarafını Electron ile karşılaştırarak incele → 35 bulgu, hepsi düzeltildi
2. Tauri ikonu farklı olsun → yeşil/turkuaz ikon seti
3. Uygulamayı çalıştır → derleme ortamı (VS 2022 + cmake), `scripts/win-env.cmd`
4. Her şeyi istisnasız kontrol et, çalışmayanları not et, senaryo, tek tek düzelt → `--qa` harness, `docs/QA_WINDOWS.md`
5. Hızlı yapıştır donuyor → A5
6. Video ve kaydırmalı yakalama yapılmalı → A8
7. Video ters → A6
8. Kaydırmalı yakalamada Bitir sonrası düğmeler → A7
9. Kalan video işleri + her talep kontrol listesine, kontrollü ilerleme → bu dosya, B bölümü
10. Görüntüleyici dar pencerede araç düğmelerini "…" menüsüne topla; küçült/büyüt/kapat görünsün → A10
11. Eski (Electron) ile yeni (Tauri) arasında ekran görüntüsü/video performans kazanımı var mı → D12 (ölçüm: `docs/PERF_WINDOWS.md`)
12. Yaptıklarımızı aynı dalda commit'leyip gönder → D10
