# CopyBoard v2.9.3 Release Notes

Renk kodu alma, kısayol başına aç/kapa, görünür ipuçları ve galeri araç çubuğu.

## 🎨 Renk Kodu Al (yeni)
- Yeni kısayol (varsayılan **Alt+3**) ve tepsi menüsü öğesi: ekran donuyor, büyüteç imlecin altındaki pikselin hex kodunu canlı gösteriyor, tek tık kodu panoya + geçmişe alıyor (`Renk kodu kopyalandı: #336699`), **Esc** iptal ediyor.
- Bu modda ekran **karartılmıyor** — normal ekran görüntüsü modundaki %50 karartma, kopyalanandan başka bir renk görmene sebep olurdu. Seçim kutusu/araç çubuğu da gizli; büyüteç tek araç.
- Büyüteç etiketi ile tıklamanın kopyaladığı değer artık **aynı kaynaktan** (ekran görüntüsü katmanı) okunuyor; önceden etiket büyütülmüş kopyadan örneklendiği için ayrışabilirdi.

## 🎚️ Kısayol başına aç/kapa
- Ayarlar'da her kısayolun yanında bir anahtar var. Kapatınca kısayol işletim sisteminden **bırakılıyor**, yani o kombinasyon başka uygulamalara serbest kalıyor — CopyBoard'un bir tuşu gasp etmesi böylece çözülüyor.
- Kısayolun **değeri silinmiyor**: girdi soluklaşıyor ama bağlama duruyor, tekrar açınca aynı tuşla geri geliyor. Kapalıyken değiştirilirse yeni değer saklanıyor, açıldığı anda kaydediliyor.
- Kapalı bir kısayol tepsi menüsünde de gösterilmiyor ve menü açıkken tetiklemiyor; menü öğesinin kendisi tıklamayla çalışmaya devam ediyor. Tercih kalıcı.

## 💬 İpuçları artık görünüyor
- Ana pencere "her zaman üstte" olduğu için, macOS'un yerel `title` ipuçları (ayrı bir sistem penceresinde normal seviyede çizilir) **pencerenin arkasında kalıyor ve hiç görünmüyordu** — başlıktaki düğmeler, ayar satırları, hepsi.
- İpuçları artık sayfanın içinde çiziliyor: bir öğenin üzerine ilk gelindiğinde `title` otomatik olarak sayfa-içi ipucuna dönüştürülüyor (yerel olan kaldırılıyor, çift ipucu olmuyor). Sonradan oluşturulan satır/düğmeler de kapsanıyor; pencere kenarına yaklaşınca yukarı dönüyor.
- Geçmiş satırlarının 500 ms'lik ipucu da aynı elemanı kullanıyor — tek sistem, iki ipucu asla üst üste binmiyor.

## 🖼️ Galeri araç çubuğu
- Grid düğmelerinin karşısına, sola iki galeri-geneli işlem eklendi: **Klasörde Göster** (ekran görüntüsü klasörünü açar) ve **Büyük Görüntüle** (en yeni görüntüyü büyük pencerede açar). Galeri boşken ikisi de pasif.

## ✨ Görünüm
- Ayar panelindeki tüm onay kutuları **kayan anahtar** (switch) görünümüne geçti. Tamamen görsel: öğeler hâlâ gerçek checkbox olduğundan mevcut mantık, etiket tıklaması ve klavye erişimi değişmedi.

---

# CopyBoard v2.9.2 Release Notes

macOS menü çubuğu (tepsi) simgesi düzeltmeleri.

## 🍎 Tepsi simgesi artık pencereyi açıyor
- macOS'ta simgeye **sol tıklamak menüyü açıyordu**; `setContextMenu()` bağlandığında AppKit sol tıklamayı menüye ayırıyor ve koddaki `tray.on('click', showMain)` hiç çalışmıyordu. Artık **sol tık pencereyi açıp kapatıyor**, menü (Göster / Hızlı Yapıştır / Ekran Görüntüsü / OCR / Video / Çıkış) **sağ tıkta**. Windows/Linux davranışı değişmedi.
- Açık pencerede simgeye tıklayınca kapanıyor: pencere zaten `blur` ile gizlendiği için tıklama olayı geldiğinde kapanmış oluyordu ve saf bir "görünürse gizle" mantığı onu hemen yeniden açardı; yeni yeni gizlenmiş bir pencere artık "bu tıklama kapattı" sayılıyor.

## 🚫 "Göster" bazen hiçbir şey yapmıyordu
- Tepsiden gösterilen pencere, macOS odağı önceki uygulamaya geri verirken **anında `blur` alıp kendini tekrar gizleyebiliyordu** — tıklama boşa gitmiş gibi görünüyordu. Kasıtlı bir gösterimden hemen sonraki blur artık yok sayılıyor (600 ms), ayrıca dock gizli (accessory) uygulama olduğu için macOS'ta `app.focus({steal:true})` ile uygulama gerçekten öne alınıyor.

## ⌨️ Menü açıkken basılan kısayollar birikip topluca patlamıyor
- macOS'ta yerel menü **modal bir olay döngüsü** çalıştırır: menü açıkken ana süreç `globalShortcut` geri çağrılarını işlemez, basılan her kısayol **kuyruğa girer** ve menü kapanınca hepsi birden tetiklenirdi (arka arkaya ekran görüntüsü/OCR/kayıt). Menü açılırken kısayol kayıtları bırakılıyor, kapanınca geri alınıyor: basış artık gerçekten yok sayılıyor. Kapanış olayı hiç gelmezse 60 sn'lik emniyet zamanlayıcısı kayıtları geri yükler.

---

# CopyBoard v2.9.1 Release Notes

macOS'ta ilk ekran görüntüsü artık siyah yapışmıyor; genel performans iyileştirmeleri.

## 📸 İlk çekimde siyah görüntü düzeltildi (macOS)
- Uygulama açıldıktan sonraki **ilk** ekran görüntüsü, panoya yapıştırıldığında **siyah bir dikdörtgen** (üzerinde yalnızca ok/çizimler) çıkabiliyordu; ikinci çekim her zaman düzgündü. Sebep: macOS'ta oturumun ilk `desktopCapturer.getSources()` çağrısı, ScreenCaptureKit henüz ısınmadığı için **boş bir kare** döndürebiliyor (0 baytlık PNG). Bu boş veri ekran katmanına hiç çizilemiyordu; overlay penceresi saydam olduğu için altındaki canlı masaüstü görünüyor ve her şey normal sanılıyordu — ta ki kopya yapıştırılana kadar.
- Çözüm kendi kendini iyileştirme üzerine kurulu, kullanıcıya soru sorulmuyor:
  - Ana süreç boş kareyi fark edip çekimi kısa aralıklarla kendisi yineliyor (ekran başına 5 deneme).
  - Yine de kullanılamaz görüntü ulaşırsa (boş/bozuk PNG), overlay yeni `capture-retry` kanalıyla **sessizce yeni bir yakalama istiyor**; pencere ancak kullanılabilir görüntüyle görünür olduğundan bu denemeler tamamen görünmez.
  - Tüm denemeler tükenirse (ör. Ekran Kaydı izni geri alınmışsa) engelleyici pencere yerine kısa bir bildirim gösterilip overlay kapatılıyor; uygulama askıda kalmıyor.
- Kopyalama son bir güvenlik denetiminden geçiyor: tamamen saydam (yapıştırıldığında siyah görünecek) bir kırpma artık panoya hiç gönderilmiyor.

## 🖼️ Görüntünün sessizce silinmesi engellendi (Snipper, OCR, Kayıt)
- Yakalama yüklendikten sonra gelen bir pencere `resize` olayı, canvas boyutu yeniden atandığı için **ekran görüntüsünü, çizimleri ve geri-al geçmişini sessizce siliyordu** — saydam pencere yüzünden yine fark edilmiyordu. Görüntü artık bellekte tutuluyor; boyut değişiminde silinmek yerine yeniden çiziliyor. Aynı düzeltme OCR ve ekran kaydı bölge seçimine de uygulandı.

## ⚡ Genel Performans
- **Geçmiş yazmaları artık toplu:** her pano kopyalaması, tüm ayar dosyasını (~1MB'a ulaşabiliyor) ana süreçte senkron olarak baştan yazdırıyordu. Yazmalar yarım saniyelik pencerede birleştiriliyor; çıkışta ve uyku/kilitte anında diske işleniyor. Saklanan veri değişmiyor.
- **Yayınlar yalnızca görünür pencerelere:** her kopyalamada ~0,5MB'lık geçmiş, gizli olsalar bile 3 pencereye IPC ile gönderiliyordu. Artık yalnızca görünür pencereler push alıyor; gizli pencereler açılırken güncel veriyi kendileri çekiyor (veri kaybı yok).
- **Aşırı büyük kopyalar (1MB+ metin) geçmişe alınmıyor:** ya bütün olarak saklanır ya hiç — kesilerek saklama yok (kesik öğe daha sonra panoya eksik yapışırdı). Pano işleyişi etkilenmez; bu sınır ayar dosyasının kontrolsüz büyüyüp açılışı yavaşlatmasını önler.
- **Liste satırları tek satır:** geçmiş/favori satırları artık tek satırda üç nokta ile kısaltılıyor (tarih aynı satırın sağında); öğenin geniş hali imleç satırın üzerinde **500 ms** durunca çıkan araç ipucunda gösteriliyor. İpucu içeriği yalnızca o anda kuruluyor — satır başına DOM metni ~%85 azaldı, çok satırlı sarma hesabı kalktı (ana pencere + widget + hızlı yapıştır). Kopyalama ve arama her zaman bellekteki tam içerikle çalışır.
- **Toast bildirimleri tek pencereyi yeniden kullanıyor:** her bildirim yeni bir renderer süreci başlatıyordu (~100-300ms). Pencere bir kez kurulup gizlenerek yeniden kullanılıyor (v2.9.0'daki imleç-ekranı konumlandırması ve tam ekran üstü görünürlük korunuyor).
- **OCR belleği boşta serbest bırakılıyor:** Tesseract işçisi ilk taramadan sonra süresiz bellekte kalıyordu (150MB+). 5 dakika kullanılmayınca kapatılıyor; sonraki tarama yalnızca 1-2 sn ısınma bedeli öder (v2.9.0'ın çevrimdışı dil paketi sayesinde indirme gerektirmez).
- **Widget "üstte tut" zamanlayıcısı seyreltildi** (3sn → 10sn): gösterimde ve her konum değişiminde zaten yeniden uygulanıyor; sık aralık boşuna uyandırıyordu.

## 🧭 Arayüz
- **Bildirim (toast) yüksekliği içeriğe göre ayarlanıyor:** pencere sabit 320×100 olduğu için uzun mesajların sonu kırpılıyor ve okunamıyordu (ör. Erişilebilirlik izni uyarısı 138 px gerektiriyordu, 38 px'i görünmüyordu). Kart artık ölçülüp pencere ona göre büyütülüyor/küçültülüyor; kart pencere dışında beklediği için boyutlanma görünmez, sağ-üst köşe sabit kalıyor.
- **"+" (Manuel Ekle) düğmesi kaldırıldı** — artık gerekmiyordu; düğme, modal, DOM referansları, preload köprüsü (`addManualItem`) ve ana süreçteki `add-manual-item` IPC handler'ı dahil tüm zincir söküldü. Yerine başlıkta **Geçmiş** düğmesi var: galeri/ayarlar/hakkında panellerinden tek tıkla geçmiş listesine (Tümü sekmesi) dönülüyor — galeri düğmesinin simetriği.
- **Widget geçmiş paneli ana pencereyle tutarlı:** satırlar aynı tasarımda — tek satır metin + sağda tarih-saat, aynı yazı boyutu/rengi, aynı 500 ms araç ipucu. Sanal kaydırma satır yüksekliği yeni kompakt düzene göre güncellendi (56→44 px).

## 🖥️ Windows
- Boş ilk kare macOS'a özgü bir durum; Windows'ta davranış pratikte değişmedi (aynı korumalar orada da devrede ama tetiklenmeleri beklenmez). Performans iyileştirmeleri iki platformda da geçerli.

---

# CopyBoard v2.9.0 Release Notes

Galeri yenilendi: büyük görüntüleyici penceresi geldi; macOS düzeltmeleri, çevrimdışı OCR ve video kaydı iyileştirmeleri.

## 🖼️ Büyük Görüntüleyici (yeni)
- Ekran görüntüleri artık ekrana göre boyutlanan, yeniden boyutlandırılabilir ayrı bir pencerede açılıyor: **←/→** ile gezinme, fareyle beliren yan oklar, altta tıklanabilir **filmstrip** (aktif kare vurgulu), başlıkta boyut • tarih • "3 / 25" konumu.
- Pencereden büyük görsellerde tıkla → gerçek boyut (kaydırılabilir), tekrar tıkla → sığdır. Araç çubuğunda Kopyala / Klasörde Göster; **Esc** kapatır.

## 🖼️ Galeri
- Küçük panel-içi önizleme kaldırıldı; her işlem ızgarada: kareye **tıkla → kopyala** (geçmiş satırlarıyla aynı jest, yeşil çerçeve + toast geri bildirimi).
- Her karenin köşesinde dikey işlem sütunu: **Büyüt / Kopyala / Klasörde Göster / Sil**; sağ tık menüsüne **Büyük Görüntüle** eklendi.
- Görünüm değiştirici: **tek sütun** (büyük kareler) / **iki sütun**; tercih kalıcı.

## 🍎 macOS
- Kısayolla açılan ana pencere artık bulunduğunuz masaüstünde (Space) açılıyor; macOS sizi pencerenin eski masaüstüne ışınlamıyor.
- Parola yöneticilerinin gizli işaretlediği pano içerikleri (nspasteboard Concealed/Transient) Mac'te de geçmişe alınmıyor (Windows'taki korumanın eşleniği).
- Tepsi ikonu Retina ekranlarda artık net (trayIcon@2x paketleniyor).
- Toast bildirimleri imlecin olduğu ekranda çıkıyor ve tam ekran (fullscreen Space) uygulamaların üzerinde de görünüyor.

## 🔤 OCR
- eng/tur dil dosyaları uygulamayla paketleniyor (extraResources → tessdata): ilk taramada ~10MB CDN indirmesi yok, OCR çevrimdışı da çalışıyor.

## 🎬 Video Kaydı
- Chunk yazımı dosyayı her seferinde açıp kapatan senkron yazımdan tek WriteStream'e taşındı; kaydetme diyalogları asenkron — diyalog açıkken uygulama (pano izleyici dahil) donmuyor.
- Son video parçasının diske record-stop'tan önce ulaşması garanti edildi (uzun kayıtlarda son saniyenin kırpılabildiği yarış giderildi).

## ⌨️ Kısayol Ayarları
- Ok tuşları, noktalama ve numpad tuşları doğru Electron adlarıyla kaydediliyor (ör. Alt+↑); desteklenmeyen tuşlar net mesajla reddediliyor.
- Modifiersız tek tuş bağlanamıyor (yalnız "A" tuşu tüm sistemde A harfini gasp ederdi; F-tuşları istisna).

---

# CopyBoard v2.8.7 Release Notes

macOS'ta Hızlı Yapıştır artık gerçekten yapıştırıyor.

## ⚡ Hızlı Yapıştır (macOS)
- Hızlı Yapıştır'dan bir öğe seçildiğinde macOS'ta yapıştırma hiç gerçekleşmiyordu: panel açılıyor, öğe panoya kopyalanıyor, ama odaktaki metin alanına bir şey yazılmıyordu. Sebebi, tuş vuruşu gönderen kodun yalnızca Windows için yazılmış olmasıydı (`sendPasteKeystroke` macOS'ta hiçbir şey yapmadan dönüyordu). Artık macOS'ta da `Cmd+V` gönderiliyor.
- Panel açılırken o an önde olan uygulama hatırlanıyor ve yapıştırmadan hemen önce tekrar öne alınıyor; panele tıklamanın odağı kaydırdığı durumlarda seçilen öğe yanlış yere gitmiyor.
- Erişilebilirlik (Accessibility) izni yoksa sistem izin penceresi uygulama tarafından açılıyor — kullanıcının Ayarlar içinde ilgili paneli elle bulması gerekmiyor. İstem oturum başına yalnızca bir kez gösteriliyor.
- İzin verilmemişse veya yapıştırma başarısız olursa artık sessiz kalınmıyor: eksik iznin türünü (Erişilebilirlik / Otomasyon) belirten bir uyarı gösteriliyor ve öğenin panoya kopyalandığı, `Cmd+V` ile elle yapıştırılabileceği bildiriliyor.
- Bilinen davranış: macOS verilen Erişilebilirlik iznini zaten çalışan bir uygulamaya uygulamaz; izni verdikten sonra CopyBoard'un bir kez yeniden başlatılması gerekir.

## 🔏 macOS Kod İmzası
- macOS uygulaması şimdiye kadar hiç yeniden imzalanmıyordu: `identity: null` olduğu için electron-builder imzalamayı tamamen atlıyor ve paket, stok Electron ikilisinin ad-hoc imzasını taşıyordu. Sonuç olarak uygulamanın kod kimliği `Identifier=Electron` görünüyor, CDHash'i makinedeki diğer imzasız Electron uygulamalarıyla aynı oluyor ve uygulama kodu (`app.asar`) imza kapsamına hiç girmiyordu.
- Build'e `afterPack` adımı eklendi (`scripts/mac-adhoc-sign.js`): paket, gerçek bundle kimliğiyle ad-hoc yeniden imzalanıyor (`Identifier=com.nurullahyayan.copyboard`, helper'lar kendi alt kimlikleriyle). Bu, macOS izinlerinin (Erişilebilirlik/Otomasyon) doğru uygulamaya bağlanması için gerekli; sertifika ya da Apple hesabı gerektirmiyor.
- **Bu sürüme geçen macOS kullanıcıları Erişilebilirlik iznini bir kez yeniden vermek zorunda:** uygulamanın kod kimliği değiştiği için macOS eski izni tanımaz. Ayarlar → Gizlilik ve Güvenlik → Erişilebilirlik listesinde eski "CopyBoard" satırı varsa `−` ile kaldırın; yeni izin ilk Hızlı Yapıştır kullanımında istenecektir.
- Bu bir Developer ID imzası **değildir**. Ad-hoc imzada takım kimliği bulunmadığı için Gatekeeper uygulamayı hâlâ "doğrulanmamış geliştirici" sayar ve kod her değiştiğinde CDHash değişeceğinden izinler her sürümde yeniden istenir. Kalıcı çözüm Developer ID + notarization.

## 🖥️ Windows
- Bu sürümde Windows tarafındaki yapıştırma davranışı ve imzalama akışı değişmedi.

---

# CopyBoard v2.8.6 Release Notes

Ekran kaydına ses ekleme.

## 🎬 Ekran Kaydında Ses (yeni)
- Kayıt araç çubuğuna **🎤 Mikrofon** ve **🔊 Sistem Sesi (bilgisayar sesi)** aç/kapa düğmeleri eklendi; ikisi birlikte açıldığında tek ses kanalında mikslenir.
- Kapalı kaynağın ikonunda çapraz çizgi gösterilir (susturulmuş göstergesi); seçim sonraki kayıtlar için hatırlanır.
- Windows'ta mikrofon ve sistem sesi doğrudan çalışır. macOS'ta mikrofon desteklenir; sistem sesi işletim sisteminin desteklediği sürümlerde kaydedilir, aksi halde sanal ses aygıtı (ör. BlackHole) öneren bir uyarı gösterilir.
- Bir ses kaynağı alınamazsa kayıt sessizce iptal olmaz: uyarı verilir ve video (+ alınabilen ses) ile devam eder.

---

# CopyBoard v2.8.5 Release Notes

Kısayol ve Hızlı Yapıştır düzeltmeleri.

## ⚡ Hızlı Yapıştır
- Hızlı Yapıştır kısayolu (Ctrl+Shift+V) başka bir uygulamaca kullanılıyorsa kayıt sessizce başarısız oluyor ve pencere hiç açılmıyordu; artık başlangıçta her kısayolun kayıt sonucu denetleniyor ve paste kısayolu kaydedilemezse açıklayıcı bir uyarı gösteriliyor.
- Tepsi (tray) menüsüne **"Hızlı Yapıştır"** eklendi — kısayol hangi sebeple olursa olsun (çakışma, RDP/uç nokta politikası, rezerve kombinasyon) çalışmasa bile pencere her zaman buradan açılabilir.

## ⌨️ Kısayollar
- Cmd/Ctrl + {C, V, X, A, Z} gibi sistem Kopyala/Kes/Yapıştır tuşları genel kısayol olarak çalışamaz (öndeki uygulama yakalar ya da sistem kopyalaması bozulur); bu kombinasyonlar artık reddediliyor ve kullanıcı Alt/Shift eklemeye yönlendiriliyor — özellikle macOS'ta ekran görüntüsü için Cmd+C denemesini giderir.
- Daha önce kaydedilmiş geçersiz (rezerve) bir kısayol açılışta varsayılana döndürülür; böylece hem kısayol hem de Ayarlar ekranı düzelir.
- Başlangıç kaydı artık her kısayol için ayrı ayrı yapılıyor; biri başarısız olsa bile diğerleri etkilenmiyor.

---

# CopyBoard v2.8.4 Release Notes

Ekran Görüntüsü Galerisi için düzeltmeler.

## 🖼️ Galeri
- Küçük resme **sağ tık** → Kopyala / Klasörde Göster / Sil menüsü.
- Dosyası dışarıdan silinen ekran görüntüsünün ölü/tıklanmayan kaydı artık galeriden otomatik temizlenir (açılışta ve tıklama/kopyalama denemesinde).

---

# CopyBoard v2.8.3 Release Notes

Ekran görüntüsü aracı büyük güncelleme aldı: galeri, büyüteç/renk seçici, hassas seçim ve hız iyileştirmeleri.

## 🖼️ Ekran Görüntüsü Galerisi (yeni)
- Kopyalanan/kaydedilen ekran görüntüleri otomatik saklanır (son 30); ana penceredeki galeri butonundan küçük resim ızgarası, büyük önizleme, kopyala/klasörde göster/sil.

## 🔍 Büyüteç ve Renk Seçici (yeni)
- Seçim sırasında piksel büyüteci: koordinat + renk kodu; **C** tuşu renk kodunu panoya kopyalar (geçmişe de düşer).

## 🎯 Hassas Seçim
- **Enter** = kopyala; ok tuşları = 1px taşı, Shift+ok = boyutlandır, Ctrl = 10px adım.

## ⚡ Performans
- Yakalama ile overlay hazırlığı paralel (kararma daha hızlı); ekran görüntüsü aktarımı binary (base64 kalktı); blur aracı downscale tekniğiyle çok daha hızlı; undo geçmişi bayt bütçeli (4K+ bellek dostu).

---

# CopyBoard v2.8.2 Release Notes

Çoklu monitörde ekran yakalama artık "en son seçim kazanır" mantığıyla çalışıyor (bir ekranda seçip başka ekrana geçince önceki iptal olur), ekranlar daha hızlı kararıyor; yüzen widget ikonunun hover/leave'de kayması giderildi.

## 🖥️ Ekran Yakalama (Çoklu Monitör)
- Bir monitörde alan seçip başka monitörde seçim başlatınca önceki iptal olur; sadece en son seçilen alan kalır. Diğer ekranlar tam karanlık ve seçilebilir kalır.
- Ekranların kararması hızlandırıldı (sınırlı eşzamanlı yakalama; bellek sıçraması yok).

## 🎯 Widget
- Ana ikonun hover/leave sırasında 1-2px kayması düzeltildi.

---

# CopyBoard v2.8.1 Release Notes

Hızlı Yapıştır kısayolu **Ctrl + Shift + V** olarak değiştirildi (önceki: Alt + X). Ayarlar → Hızlı Yapıştır'dan özelleştirilebilir.

---

# CopyBoard v2.8.0 Release Notes

Öne çıkan yenilik **Hızlı Yapıştır** (Alt+X): panodan seçip odaktaki metin kutusuna anında yapıştırma. Ayrıca yüzen widget'ta kenar ve tıklama iyileştirmeleri.

## ✨ Yeni Özellikler
### 📋 Hızlı Yapıştır (Alt+X)
- Bir metin kutusundayken **Alt+X** ile imlecin yanında son pano öğeleri açılır; tıkladığınız öğe doğrudan o kutuya yapışır (pencere odağı kaybolmaz).
- Gösterilecek öğe sayısı **Ayarlar**'dan ayarlanabilir (varsayılan 20).
- `Esc` / ✕ / tekrar `Alt+X` ile kapanır. Kısayol Ayarlar'dan değiştirilebilir.

## 🎨 Widget İyileştirmeleri
- Widget kenarlarındaki gölge artığı giderildi (tam düz görünüm).
- Butonun hemen dışına yapılan tıklamalar artık arkadaki uygulamaya geçiyor (görünmez "ölü bölge" kaldırıldı).

---

# CopyBoard v2.7.0 Release Notes

Bu sürümün en büyük yeniliği **çoklu monitör desteği**: artık Ekran Görüntüsü, Metin Tara (OCR) ve Video Kaydı araçlarını istediğiniz monitörde kullanabilirsiniz. Ayrıca arayüz sadeleştirildi ve birçok kullanım kolaylığı ile kararlılık iyileştirmesi eklendi.

## ✨ Yeni Özellikler

### 🖥️ Çoklu Monitör Desteği
Önceden ekran araçları yalnızca farenin bulunduğu ekranda açılıyordu. Artık kısayola bastığınızda **tüm ekranlarınız aynı anda kararır** ve dilediğiniz monitörde alanı seçebilirsiniz. Bu; **Ekran Görüntüsü**, **Metin Tara (OCR)** ve **Video Kaydı** araçlarının hepsi için geçerli.
- Video kaydında alanı hangi monitörde çizerseniz o monitör kaydedilir.

### 🔄 Otomatik Güncelleme Kontrolü
Uygulama açılışında güncellemeleri **otomatik kontrol ediyor**; yeni bir sürüm varsa sizi bilgilendiriyor.

## 🎨 Görünüm ve Kullanım İyileştirmeleri
- **Sadeleşen Widget:** Yüzen araç daha modern, düz (flat) bir görünüme kavuştu; eski parlak/bombeli görünüm kaldırıldı.
- **Daha Düzenli Ayarlar Ekranı:** Ayarları açtığınızda yalnızca ayarlar görünüyor (pano geçmişi arkada görünmüyor), uzun liste rahatça kaydırılıyor ve **"Geçmişi Temizle"** butonuna her zaman ulaşabiliyorsunuz.
- **Küçük Kolaylıklar:** "Yeni Öğe Ekle" penceresinde **Ctrl+Enter** ile ekleyebilir, **Esc** ile yalnızca o pencereyi kapatabilirsiniz.

## 🎥 Video Kaydı
- **Temiz Kayıt:** Kayıt sırasında ekranda gördüğünüz seçim çerçevesi artık **videoya yansımıyor** — kayıtlarınız tertemiz çıkıyor.

## 🐛 Düzeltmeler ve Kararlılık
- **Daha İyi Bilgilendirme:** OCR bir metin bulamadığında veya bir işlem başarısız olduğunda artık kısa bir mesajla bilgilendiriliyorsunuz (önceden sessiz kalabiliyordu).
- **Kısayol Uyarısı:** Atadığınız bir kısayol başka bir uygulama tarafından kullanılıyorsa uyarı alıyorsunuz ve önceki çalışan kısayolunuz korunuyor.
- **Favoriler:** Arama yaparken favorileri sürükleyip sıralarken oluşan sıralama hatası giderildi.
- **Notlar:** Aynı metni tekrar kopyaladığınızda favori notunuz kaybolmuyor.
- **Ekran Alıntısı:** Metin (yazı) aracını kullanırken Ctrl+Z / Ctrl+C / Esc tuşlarının yanlış davranması düzeltildi.
- **Görüntü Kaydetme:** Ekran görüntüsü kaydedilirken bir sorun olursa artık uygulama çökme ekranı yerine dostça bir uyarı gösteriliyor.
- **Güvenlik ve Altyapı:** Güncelleme penceresi ve arka plan bileşenlerinde güvenlik ve kararlılık iyileştirmeleri yapıldı.
