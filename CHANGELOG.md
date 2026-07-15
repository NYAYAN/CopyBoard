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
