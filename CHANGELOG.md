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
