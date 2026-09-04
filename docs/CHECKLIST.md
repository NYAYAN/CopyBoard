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
- [~] A11. Birden fazla monitörde ekran görüntüsü / OCR / kaydırmalı / video: alan seçilemiyor (2026-09-03). Bu makinede tek monitör var, üretilemedi. Kodda bulunan hata (Windows, karışık DPI): overlay `geom::place` ile nokta→monitör aramasından ölçek alıyordu; ikinci monitörün mantıksal köşesi birincinin dikdörtgenine düşünce yanlış ölçekle birinci ekranın üstüne yerleşiyordu → `place_on_monitor` (hedef monitörün kendi ölçeği, fiziksel konum+boyut), `snip_ready` sonrası yeniden uygulama, günlüğe monitör listesi ve gerçekleşen overlay dikdörtgeni (birim test: `overlay_dikdortgeni_monitorun_kendi_olcegiyle_hesaplanir`). Kullanıcı düzeni: Windows, 3 monitör, hepsi %100 (sol 1080×1920, orta 2560×1440, sağ 1080×1920), üçü de kararıyor ama seçim yok → karışık DPI değil. ASIL KÖK NEDEN: Tauri `listen()` varsayılan hedefi `Any` ve Any dinleyici başka pencereye `emit_to` ile giden olayları da alıyor (tauri `listener.rs`: `target == Any || filter`); seçim başlayınca diğer overlay'lere giden `capture-reset` seçimi başlatan overlay'e de ulaşıp seçimi anında sıfırlıyordu, her overlay ayrıca üç `capture-screen` alıp yanlış boyutla kuruluyordu. Düzeltme: `api-tauri.js` dinleyicileri kendi etiketini (`AnyLabel`) hedefliyor. Doğrulama: `--qa` 9b-2 üç kontrol (sızıntı yok / kendi etiketi ulaşıyor / `emit` yayını ulaşıyor). 3 monitörde gözle doğrulama bekliyor
- [~] A12. Kaydırmalı yakalama: Başlat'a basıp hemen Bitir deyince tuhaf davranış (2026-09-03, diğer makine, 3 monitör). Tek monitörde arayüz akışı `--qa` 9d ile üretildi: seç → Başlat → hemen Bitir → "Hiçbir şey yakalanamadı" ile seçim evresine dönüş, akış bırakıldı, overlay açık; tekrar Başlat → akış yeniden kuruldu → Bitir → inceleme evresi; JS hatası yok. Eski derlemede çok monitörde `capture-screen` sızıntısı (A11) kırpma ölçeğini bozuyordu → 5a1e1a9 ile yeniden deneme + "tuhaf"ın tarifi bekleniyor
- [~] A13. Video: "Kaydı başlat" deyince kayıt başlamıyor görünüyor (2026-09-03; bu PC'de tek monitörde de). KÖK NEDEN: kayıt Rust tarafında başlıyordu (günlük: "kayıt: 550x458 @30fps" iki kez, 5 sn arayla — kullanıcı yeniden basmış), ama porta geçişte başlatma sonrası araç çubuğunu değiştiren satırlar (Kaydı Başlat/tam ekran/kalite/ses gizle, Durdur + sayaç göster) düşmüştü; arayüz hiç değişmediği için "başlamadı" görünüyordu. QA 9e yalnız RecorderState'e baktığı için geçiyordu. Düzeltme: geçişler geri kondu (başlat + durdur simetrik), QA 9e arayüz durumunu da denetliyor. Gözle doğrulama bekliyor (bu PC + 3 monitör)
- [~] A14. Video: Durdur → kaydetme paneli gelmiyor; ayrıca durdurunca ekran kararıp yeniden alan seçme geliyor ve kısa bir takılma var (2026-09-04, diğer PC, 3 monitör). Üç ayrı iş: (1) PANEL KONUMU — `record_stop` paneli açmadan önce overlay'i gizliyor ve panele parent vermiyordu; sahipsiz panel Windows'ta öndeki pencereye/birincil monitöre göre konumlanıyor. Ekran görüntüsü yolu (`capture::save_png`) bunu doğru yapıyordu: gizleme yok, her-zaman-üstte indir + `set_parent`. Aynı kalıp kayda uygulandı; var olmayan Videolar dizini verilmiyor; tüm dallar günlüğe yazılıyor. (2) KARARAN EKRAN — durdurunca renderer seçim arayüzünü ve bir dakika önceki donmuş görüntüyü geri getiriyordu (pencere artık gizlenmediği için görülüyor); sayfa tamamen boşaltılıyor, pencere yalnız panelin sahibi olarak görünmez ve tıklama-geçirgen duruyor. (3) TAKILMA — 1 dk'lık kayıtta mux dosyayı kapatırken ~1,3 sn geçiyor, o boşlukta hiçbir geri bildirim yoktu; "Video hazırlanıyor…" yazısı eklendi, panel açılırken `record-save-ready` ile kalkıyor. Doğrulama: `--qa` 9f (60 sn kayıt: 1548 kare/113 MB, Durdur'dan 1305 ms sonra panel açıldı, önde, doğru monitörde, sayfa boşaldı, iptalde yol panoya; ana thread bekçisi sessiz). KULLANICIDA HÂLÂ GELMİYOR (3. bildirim, 2026-09-04): bu makinede üretilemedi. (4) 4. bildirim ("durdur deyince kayboluyor, sonrasında hiçbir şey olmuyor") → SAHİP PENCERE HAZIRLIĞI: overlay kayıt boyunca tıklama-geçirgen (`WS_EX_TRANSPARENT`) ve her zaman üstte; kullanıcı bir dakika başka uygulamalarla çalıştığı için süreç ön planda olmayabiliyor ve Windows ön planda olmayan bir sürecin penceresini öne çıkarmıyor — panel açılsa bile arkada kalıyor. Panelden hemen önce: isabet kaydı temizleniyor, `set_ignore_cursor_events(false)`, `set_always_on_top(false)`, `set_focus()`. (5) EMNİYET — panel 8 sn içinde açılmamışsa (Win32 ile gerçekten var mı diye bakılıyor: panel AÇIKSA bekçi susuyor, kullanıcı klasör seçiyor olabilir) yol panoya kopyalanıyor, uyarı toast'ı çıkıyor, günlüğe görünür pencere listesiyle yazılıyor. Panel arama `platform::windows::find_open_file_dialog` içinde; QA da aynı sorguyu kullanıyor. (6) 5. bildirim ("durdurunca kayboluyor, tepki yok; yeni kayıtta İŞLEM DEVAM EDİYOR diyor") → oturum hiç kapanmıyor, yani `record_stop` bitmiyor. İki aday: `Recording::stop()` bloklu kalıyor (windows-capture'ın `stop()`u yakalama thread'ine WM_QUIT yollayana kadar DÖNGÜDE bekliyor) ya da panel açık ama görünmüyor (bekçi paneli bulup susuyor). Ayırt etmek için: `Recording::stop()` üç aşamayı ayrı ayrı günlüğe yazıyor ("durdurma: yakalama/ses/yazıcı … +ms"); durdurma 10 sn sürerse uyarı toast'ı + günlük, 25 sn'de oturum serbest bırakılıyor (kullanıcı yeniden kayıt yapabilsin); bekçi paneli bulunca artık `warn` seviyesinde HWND ve dikdörtgenini yazıyor. Bu makinede ses AÇIK + 30 sn kayıtla denendi: yakalama +15 ms, ses +48 ms, yazıcı +496 ms, panel 1306 ms'de açıldı — üretilemedi. (7) 6. bildirim ("'Video hazırlanıyor' yazısı ekranda KALIYOR") → KESİN: `record-save-ready` hiç gelmiyor, yani `record_stop` panele hiç ulaşmıyor; durdurma bloklu kalıyor. İki düzeltme: (a) NAZİK DURDURMA — `windows-capture`nin `CaptureControl::stop()`u yakalama thread'ine WM_QUIT yollayabilene kadar döngüde bekliyor ve thread'in mesaj kuyruğu yoksa `ERROR_INVALID_THREAD_ID` ile sonsuza dek dönüyor; artık işleyiciye "dur" bayrağı veriliyor, o bir sonraki karede `InternalCaptureControl::stop()` çağırıp thread'i kendi bitiriyor, dışarıdan `stop()` ancak yarım saniye içinde bitmezse çağrılıyor (bu makinede 20–40 ms, günlükte "nazik"). (b) MUX ZAMAN AŞIMI — `IMFSinkWriter::Finalize()` donanım kodlayıcısını boşaltıyor ve sürücü takılırsa süresiz bekleyebiliyor; ayrı thread + 20 sn zaman aşımı, dolarsa ham dosya yolunu içeren hata dönüyor. Ayrıca uyarılar AŞAMA ADINI yazıyor. (8) 7. bildirim ("video dosyası hazırlanıyor, sonra video verisi hatası") → AŞAMA BULUNDU: takılma `IMFSinkWriter::Finalize()`, yani mux sonlandırma. Boş ses izi hipotezi `COPYBOARD_FORCE_AUDIO_FAIL=1` ile sınandı ve ELENDİ (ses istendi ama açılamadı → sonlandırma 920 ms). Demek ki o makinede sonlandırma gerçekten uzun sürüyor (donanım kodlayıcısı/sürücü). Yeni tasarım: durdurma kendi thread'inde; 12 sn'de bitmezse OTURUM BIRAKILIYOR (overlay kapanır, uygulama serbest, "İşlem devam ediyor" duvarı yok) ve hazırlama arka planda sürüyor. Bittiğinde panel yerine dosya doğrudan Videolar klasörüne alınıp yolu panoya kopyalanıyor ve söyleniyor — kayıt HER hâlükârda elde kalıyor. Sonlandırma üst sınırı 20 sn → 5 dk. (9) 8. bildirim ("3 monitör yüzünden mi? aynı durum, video hazırlanıyor diye kalıyor") → monitör sayısı doğrudan ilgili değil (takılan adım mux), ama aynı GPU üç ekranı sürerken donanım H.264 kodlayıcısı zorlanıyor olabilir. YAZILIM KODLAYICISI seçeneği eklendi: `MfWriter::new(..., hardware)`; `COPYBOARD_SOFTWARE_ENCODER` ortam değişkeni baştan kapatıyor, sonlandırma düşerse otomatik olarak yazılıma geçiliyor (`set_hardware_encoder(false)`) ve kullanıcıya söyleniyor. Günlükte artık "kodlayıcı=donanım/yazılım" yazıyor. Bu makinede yazılım yolu doğrulandı: 10 sn kayıt, 188 kare, sonlandırma 402 ms
- [~] A15. Video: Kayıt başlattıktan sonra 3-5 sn ekrana tıklanamıyor (2026-09-04, diğer PC). KÖK NEDEN: renderer `recordStart`'ı BEKLEYİP sonra arayüzü kayıt durumuna alıyordu; motor kurulumu (ses aygıtları + kodlayıcı) sürerken overlay hâlâ tüm tıklamaları yakalıyordu (isabet alanı 'her yer'). Düzeltme: arayüz iyimser davranıp hemen kayıt durumuna geçiyor ve isabet alanı araç çubuğuna iniyor (tıklamalar alttaki uygulamaya geçer); SAYAÇ motor gerçekten başlayınca başlıyor, hata olursa arayüz seçim durumuna geri alınıyor. Ayrıca motor kurulum süresi günlüğe yazılıyor ("kayıt motoru hazır (+N ms)"): bu makinede ses açıkken 301-539 ms — kullanıcıda daha uzunsa satır bunu gösterecek
- [~] A10. Görüntüleyici dar pencerede (uzun kaydırma görüntüsü) araç çubuğu taşıyor, küçült/büyüt/kapat görünmüyor → Çiz/Karşılaştır/Kopyala/Klasör/Sil "…" menüsüne toplanacak, pencere düğmeleri her zaman görünür (gözle)

## B. Video kaydı — kalan işler (Windows)

- [x] B1. Motor: WGC kare + MF H.264 → mp4, 30 fps, bölge kırpma (`--qa`)
- [x] B2. Dikey yön düzeltmesi (A6, cv2)
- [x] B3. Mikrofon sesi — WASAPI yakalama → 48 kHz stereo i16 → MF AAC (`--qa`: "ses [mikrofon]: 48000 Hz, 2 kanal, 32-bit float", mp4'te `mp4a` izi)
- [x] B4. Sistem sesi — WASAPI loopback + mikrofonla karıştırma (`--qa`: "ses [sistem] … 3,1 sn ses", 201 kbps AAC izi)
- [~] B5. Ses/video eşzamanlama — ortak QPC `t0`; gözle (dudak senk./tık sesi) bekliyor
- [x] B5b. Kodlayıcı değişti: kendi Media Foundation Sink Writer. İlk ölçümde yön ters çıktı (satır çevirme bu yolda fazlaydı), çevirme kaldırıldı (cv2: normal 0.995 / ters 0.011, 150 kare = 30 fps, `avc1` + `mp4a` izleri)
- [x] B6. Kayıt akışının arayüzü: bölge seç → Kayıt → Durdur → kaydetme paneli — `--qa` 9e (başlatma + arayüz kayıt durumu + dosya) ve 9f (Durdur → panel açıldı, önde, doğru monitörde, iptalde yol panoya)
- [x] B7. Kaydetme iptalinde geçici dosya yolu panoya (Electron davranışı) — `--qa` 9f: panel kapatıldı, panoda `copyboard_kayit_*.mp4` yolu
- [ ] B8. Çok monitör: doğru monitörden kayıt (`MonitorFromPoint`) — ikinci monitörde gözle
- [ ] B9. Karışık DPI'da kırpma ölçeği (renderer fiziksel piksel veriyor) — %125/%150 ekranda gözle
- [ ] B10. Windows 10 (20348 öncesi) sarı WGC çerçevesi geri dönüşü — bu makinede sınanamaz
- [x] B11. Kalite kademesi → dosya boyutu (5 sn 1280×720 + ses): low 1,2 MB (~2 Mbps), medium 2,4 MB (~4), high 5,1 MB (~8), ultra 8,2 MB (~13) — orantılı (`--record-test=<kalite>,5`)
- [x] B12. Uzun kayıt bellek/CPU — iki hata bulundu ve düzeltildi: (1) `DISABLE_THROTTLING` ile 30 sn'de 2,3 GB → kaldırıldı, sessiz kayıt 145 MB sabit; (2) loopback sessizken karıştırıcı ilk paketi bekleyip hiç ses yazmıyor, yazıcı videoyu tutuyordu → zaman çizgisi t0'dan başlıyor, sessizlik dolduruluyor. Son ölçüm: sesli ultra 20 sn boyunca 155–158 MB sabit, CPU tek çekirdeğin %19'u = 16 mantıksal çekirdekte toplamın ~%1,2'si (`--record-test=ultra,20`)

## C. Kaydırmalı yakalama — kalan işler (Windows)

- [x] C1. Motor: WGC → 15 fps kırpılmış RGBA → Channel (`--qa`)
- [~] C2. Bitir sonrası Kopyala/Kaydet (A7)
- [~] C3. Uçtan uca: Başlat → kaydır → Bitir → birleştirme → Kopyala/Kaydet → galeri — Başlat/Bitir/tekrar Başlat/inceleme evresi `--qa` 9d ile doğrulandı; gerçek kaydırma + Kopyala/Kaydet gözle
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
- [~] D13. Başka Windows PC'de `cargo run` çalışmadı → `scripts/win-env.cmd` sürüm/edisyon bağımsız (vswhere + msvcrt.lib doğrulaması, `COPYBOARD_VS` ile elle seçim, cmake yoksa VS kopyası/uyarı), `docs/BUILD_WINDOWS.md` (gereksinimler, sık hatalar). Hata metni geldi: düz `cargo run` cc-rs'in en yeni diye seçtiği VS 18 `cl.exe` ile düşüyor (yarım kurulum: include/lib yok) → betikle çalıştırma ya da VS 18 onarımı; kılavuza iki satır eklendi (VS 18 stub, exe kilidi). Betikle doğrulama bekleniyor
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
13. Çok monitörde ekran görüntüsünde bölge seçilemiyor → A11
14. Kaydırmalı yakalamada Başlat → hemen Bitir tuhaf davranıyor → A12
15. Video kaydı başlat deyince başlamıyor → A13
16. Diğer PC'de `cargo run` çalışmadı → D13 (derleme reçetesi)
17. Video durdurunca kaydetme paneli gelmiyor → A14
18. Kayıt başlattıktan sonra 3-5 sn ekrana tıklanamıyor → A15
