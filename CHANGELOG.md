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
