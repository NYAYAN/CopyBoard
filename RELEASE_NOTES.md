# CopyBoard v2.10.0 - Baştan Tasarlanmış Arayüz 🎨🌗🌐

Uygulamanın tamamı yeniden tasarlandı. Bunun yanında açık tema, İngilizce arayüz, ekran
görüntülerini büyük görüntüleyicide düzenleme ve artık gerçekten atanabilen kısayollar.

## 🎨 Yeni arayüz

- **Liste ön planda.** Başlık, sekmeler ve arama üç ayrı çubuktu — 550px'lik pencerenin
  132px'i ilk satırı görmeden gidiyordu. Şimdi 86px: bir başlık çubuğu, altında arama ve
  yanında kompakt sekme kontrolü. Kalan yer satırlara gitti.
- **İçerik türü artık görünüyor.** Link, e-posta, dosya, yol, kod ve çok satırlı metin
  kendi simgesini alıyor; renk kodları gerçek rengiyle çiziliyor; kod ve yol gibi yapılı
  içerik eşit genişlikli yazıyla diziliyor. Aradığınız satırı okumadan bulabiliyorsunuz.
- **Tarihler tekrar etmiyor.** Her satırda `16.08.2026 14:17` yazıyordu. Artık satırlar
  **Bugün / Dün / Bu hafta / Daha eski** başlıkları altında toplanıyor ve yalnızca
  başlığın söylemediğini yazıyor: bugün için saat, bu hafta için gün adı, öncesi için
  tarih.
- **Tema, tipografi ve aralıklar tek yerden.** Dokuz pencere kendi renk setini taşıyordu;
  aynı mor beş ayrı yerde elle yazılıydı ve dördünde kaymıştı. Hepsi tek bir tasarım
  dosyasına bağlandı. Kontrastlar göz kararı değil ölçülerek seçildi.
- **Yazı tipi artık internetten inmiyor.** Ana pencere her açılışta Google Fonts'tan Inter
  çekiyordu; diğer sekiz pencere zaten sistem yazı tipine düşmüştü. Hepsi sistemin kendi
  yazı tipini kullanıyor — daha hızlı açılış, tutarlı görünüm.

## ⌨️ Klavye ile kullanım

Pencere yalnızca Esc tuşunu tanıyordu. Artık elleriniz klavyeden kalkmadan çalışıyor:

| Tuş | İş |
|---|---|
| `↑` `↓` | Satırlar arasında gez |
| `Enter` | Kopyala ve pencereyi kapat |
| `Ctrl/Cmd + Enter` | Kopyala, pencere açık kalsın |
| `Ctrl/Cmd + ⌫` | Sil |
| `Ctrl/Cmd + D` | Favorilere ekle / çıkar |
| `Ctrl/Cmd + 1` `2` | Tümü / Favoriler |
| `Ctrl/Cmd + F` | Aramaya odaklan |
| `Esc` | Sırayla: pencereyi kapat → alt görünümden çık → aramayı temizle → gizle |

Pencere açıldığında imleç doğrudan aramada ve ilk satır seçili. Alttaki durum çubuğu
kısayolları yazıyor — görünmeyen kısayolu kimse kullanmaz.

## 🔎 Türkçe arama

Arama Türkçe karakterlerde çalışmıyordu ve bunlar istisna değil, dilin en sık harfleriydi:

- `İSTANBUL` içindeki kayıt **"istanbul"** aramasıyla bulunamıyordu
- `IŞIK` → **"isik"** bulamıyordu, `Güneş` → **"gunes"** bulamıyordu

Artık hem yazdığınız hem de kayıtlar aynı şekilde sadeleştiriliyor: **"sarki"** yazınca
`ŞARKI` geliyor, **"ŞARKI"** yazınca `sarki` geliyor. `ı` tuşu olmayan bir klavyede
"isik" yazan da `ışık`ı buluyor. Ayarlar araması da aynı şekilde çalışıyor.

## ⚙️ Ayarlar

- Her satır artık bir başlık, **ne işe yaradığını söyleyen bir açıklama** ve sağda
  kontrolden oluşuyor. "Maksimum Kayıt:" gibi iki nokta üst üstelü form etiketleri gitti.
- Bölümler **açık/kapalı durumunu hatırlıyor**. Widget'ın opaklığını ayarlamak için her
  seferinde aynı grubu açmıyorsunuz.
- Üstte **ayar araması** var: "opak" yazınca yalnızca Opaklık satırı kalıyor, bölümü de
  kendiliğinden açılıyor.
- İlk açılışta tüm bölümler kapalı — panel tek ekranda okunabilir bir başlık listesi
  olarak açılıyor.
- **Widget rengi seçici artık çalışıyor.** İşletim sisteminin renk paneli açıldığında
  odak ona geçtiği için pencere kendini gizliyordu; seçici ortada kalıyordu. Yerine
  uygulama içinde bir seçici geldi: 12 hazır renk, ton kaydırıcısı ve hex alanı.

## 🖼️ Galeri

- Her küçük resmin üzerinde duran 4 düğme **fareyle üzerine gelince** çıkıyor. Önceden
  tanımaya çalıştığınız resmin üçte birini kapatıyorlardı.
- Zaman damgası tam genişlikte bir bant değil, köşede küçük bir rozet.
- Izgarada da klavye çalışıyor: oklar, `Enter` kopyala, `O` büyük görüntüle,
  `Ctrl/Cmd + ⌫` sil.

## 🧰 Yakalama araçları

- **Araç çubuğu ipuçları ilk kez görünüyor.** Ekran alıntısı ve video kayıt araçlarındaki
  düğmelerin etiketleri, bu pencereler her şeyin üstünde durduğu için işletim sistemi
  tarafından hep arkalarında çiziliyordu — snipper'da 11, kayıtta 7 düğme etiketsizdi.
- **Üç yakalama yüzeyi tek araç çubuğu** oldu. Üç ayrı koyu ton, iki ayrı düğme boyutu ve
  imleçle büyüyen düğmeler vardı; hepsi tek ölçüye indi.
- Araç çubukları **temayı takip ediyor**. Açık temada açık, koyu temada koyu — açık temada
  kenarı kaybolmasın diye ince bir çerçeve ve daha belirgin gölge alıyorlar.
- Ekran alıntısındaki renk paleti görüntüleyicidekiyle **aynı yedi renk**; renk düğmesi
  seçili rengi gösteriyor.

## 🛟 Kaybolan veriye karşı

- **Favoriden klavyeyle çıkarma artık onay soruyor.** Favori bir kayıt notunu ve elle
  verdiğiniz sırayı taşıyor; aynı metni sonradan yeniden yıldızlamak ikisini de geri
  getirmiyor. Onay kutusu kaydı adıyla söylüyor, notu varsa onun da gideceğini yazıyor.
- **Ekran görüntüsünü klavyeyle silmek** de onay soruyor — o bir dosya.
- **Çizim yaptıktan sonra kopyalama** düzeldi. Çizim yeni bir kayda gömülüyordu ama
  orijinalin üzerinde de bekliyordu; kopyayı silip orijinale dönünce çizim geri geliyor,
  yanlış resim silinmiş gibi görünüyordu.
- **Çizim modunda oklar** artık resim değiştirmiyor. Elinizde kalemken ok tuşu "beni başka
  bir resme götür" demek değil; ekrandaki ‹ › düğmeleri ve film şeridi de kilitli.

## ⚡ Hız ve güvenlik

- Sekme geçişindeki **150ms yapay gecikme** kaldırıldı.
- Arama artık her tuş vuruşunda 500 satırı baştan çizmiyor.
- Hiçbir pencerede `unsafe-inline` içerik güvenliği politikası kalmadı.

## 🖼️ Ekran görüntülerini görüntüleyicide düzenleyin
- **Büyük Görüntüle** ekranında artık **Çiz** var: kalem, kare, yuvarlak, ok, metin ve bulanıklaştırma. Snipper'daki araçların aynısı.
- Çizim, resmin **kendi çözünürlüğünde** yapılıyor: pencere küçük olsa da kopyaladığınız resim tam kalitede.
- **Alan Seç** ile resmin bir bölgesini seçip **Alanı Kopyala** diyebilirsiniz — çizimleriniz dahil.
- Düzenlenmiş resim hem panoya kopyalanıyor hem galeride **yeni bir kayıt** oluyor; görüntüleyici de o kayda geçiyor.
- **Sil** düğmesi eklendi: ekrandaki görüntüyü siler, bir sonrakine geçer.
- Başlıkta artık boyutun yanında **dosya boyutu** da yazıyor.
- Çizimleriniz galeride ileri geri gezerken kayboluyor değil — her resim kendi çizimini hatırlıyor.

## 🔍 Görüntüleyicide yakınlaştırma
- Trackpad'de **pinch** veya **Ctrl/Cmd + tekerlek** ile yakınlaştırın; imlecin olduğu nokta yerinde kalır.
- Başlıktaki **− / % / +** kontrolünden de yapabilirsiniz. Yüzdeye tıklamak %100'e, tekrar tıklamak pencereye sığdırmaya geçirir.
- **Ctrl/Cmd +/−** adım adım, **Ctrl/Cmd+0** sığdır, **Ctrl/Cmd+1** gerçek boyut.
- %10 ile %800 arası; uzaklaştırma da var, resmi pencereye sığandan daha küçük görebilirsiniz.

## 🌗 Koyu ve açık tema
- **Koyu · Açık · Sistem** — Ayarlar'dan seçiliyor. Sistem seçiliyken işletim sisteminizi anında takip eder.
- Tema tüm pencerelere uygulanıyor: ana pencere, görüntüleyici, yüzen araç, hızlı yapıştır, kayıt penceresi, güncelleme kutusu ve bildirimler.
- Geçiş anında oluyor, hiçbir pencere yeniden yüklenmiyor — ekran görüntüsü alırken ya da video kaydederken tema değiştirmek güvenli.

## 🌐 Arayüz dili: Türkçe / İngilizce
- Ayarlar'ın en altına **Dil** satırı eklendi: Türkçe ve English.
- Uygulamanın tamamı çevrildi: her pencere, tepsi menüsü, bildirimler ve hata mesajları.
- Varsayılan Türkçe kalır; güncelleme dilinizi değiştirmez.
- Pano içeriğiniz asla çevrilmez.

## ⌨️ Kısayollar
- Kısayol atama artık **fiziksel tuşu** kaydediyor. Türkçe-Q gibi düzenlerde daha önce kaydı alınıp **hiç çalışmayan** kısayollar oluyordu; bu bitti.
- macOS'ta **Esc'in altındaki tuş** (Türkçe-Q'da `"`) dahil, daha önce atanamayan tuşlar artık atanabiliyor.
- Bu tuşlar için gereken yerel bileşen isteğe bağlıdır: yoksa uygulama normal çalışır, yalnız o tuş kullanılamaz olarak görünür.

## ⚙️ Yeniden düzenlenmiş Ayarlar
- Her şey beş katlanır başlık altında: **Kayıt Ayarları · Video Ayarları · Yüzen Araç · Kısayollar · Diğer Ayarlar**.
- Ayarlar artık kaç ayarınız olursa olsun **tek ekrana** sığıyor; aradığınızı açarsınız.
- Yüzen Araç'ın aç/kapa anahtarı başlık satırında kaldı — açmak için grubu açmanız gerekmiyor.
- **Güncellemeleri Kontrol Et** ve **Hakkında** buraya taşındı; üstteki ikon sırası altıdan dörde indi.
- Güncelleme kontrolü artık **her zaman cevap veriyor**: güncelleme yoksa da bunu söylüyor, sessiz kalmıyor.

## 🧰 Yüzen araç (widget)
- Düğmelerin **ipuçları artık görünüyor** — önceden widget'ın arkasında kalıyorlardı.
- **Hızlı Yapıştır** düğmesi menüden kaldırıldı. Özellik duruyor: kısayolundan ve tepsi menüsünden kullanılabilir.

## 🎨 Görünüm düzeltmeleri
- Açık temada okunmayan renkler tek tek ölçülerek düzeltildi: favori yıldızı, widget menü ikonları, satır düğmeleri, odaklanan arama ve not alanları, güncelleme kutusu ve hızlı yapıştır kapatma düğmesi.
- Koyu temada seçili sekmenin ikonu artık belirgin.
- Geçmiş sekmesindeyken üstteki geçmiş düğmesi de seçili görünüyor.
- Görüntüleyicide Çiz'e basınca resmin arka planının siyaha dönmesi düzeltildi; soluk ekran görüntülerinin kenarı artık belli.

## 🐞 Diğer düzeltmeler
- macOS'ta snipper'da **Cmd+Z** ve **Cmd+C** çalışıyor (önceden yalnız Ctrl kabul ediliyordu).
- Büyük görüntüleyicide yakınlaştırırken resmin çerçevenin tepesine yapışması düzeltildi.

## 📦 Kurulum & Güncelleme
1. CopyBoard-Setup-2.10.0.exe (Windows) veya CopyBoard-2.10.0-arm64.dmg (macOS) dosyasını indirip kurun; veya
2. Açık uygulamada otomatik güncelleme bildirimiyle geçin.

---
**Tam Değişiklik Listesi:** [CHANGELOG.md](CHANGELOG.md)
