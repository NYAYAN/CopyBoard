# Changelog

## [2.7.0] - 2026-07-04

### 🚀 Mimari Değişiklikler & İyileştirmeler
- **Modüler IPC**: Uygulama içi iletişim sistemi (IPC) tamamen yeniden yazılarak alt modüllere ayrıldı. Bu sayede kod tabanı daha temiz ve yönetilebilir hale geldi.
- **Performans**: Uygulama genelinde bellek kullanımı ve hız optimizasyonları yapıldı. 

### 🎨 UI/UX Geliştirmeleri
- **Widget**: Widget menüsü ve bileşenlerinin etkileşimleri daha pürüzsüz hale getirildi.
- **Araçlar**: Ekran Yakalama ve Video Kaydı araçlarında görsel ve altyapısal iyileştirmeler yapıldı.

## [2.6.3] - 2026-05-01

### ✨ Yeni Özellikler & İyileştirmeler
- **Widget "Uygulamayı Aç" Butonu**: Floating widget menüsüne ana uygulama penceresini açan bir buton eklendi.
- **Modern İkonlar**: Widget üzerindeki ikonlar daha modern ve anlaşılır sürümleriyle güncellendi (Saat/Geçmiş, Makas, Scan Text).
- **Widget Boyutlandırma**: Menü yüksekliği yeni butonu kapsayacak şekilde optimize edildi.

### 🐛 Hata Düzeltmeleri
- **Arama Sıfırlama**: Uygulama odağını kaybedip tekrar açıldığında arama kutusu ve listenin senkronize şekilde sıfırlanması sağlandı.

## [2.6.2] - 2026-04-15
- Performans iyileştirmeleri ve hata düzeltmeleri.

### ✨ Yeni Özellikler & İyileştirmeler
- **Widget Sürükleme**: Ekran kenarlarına yapışma mantığı geliştirildi, görsel boşluklar giderildi.
- **Dinamik Panel**: Widget paneli artık ekran kenarına göre (sol/sağ) doğru yönde açılıyor.
- **Kalıcı Ayarlar**: Yüzen Araç ayarının uygulama başlangıcında sıfırlanması sorunu giderildi.

## [2.5.0] - 2026-02-20

### ✨ Yeni Özellikler
- **Yüzen Kısayol Aracı (Floating Widget)**: Ana araçlara hızlı erişim sağlayan yeni masaüstü aracı.
- **Hızlı Erişim**: Pano, OCR, Snipper ve Video Kaydı araçları widget'a entegre edildi.

## [2.3.0] - 2026-01-24

### 🏗️ Mimari Değişiklikler
- **Modüler Yapı**: Uygulama altyapısı tamamen yenilendi
  - Backend: Servis tabanlı mimari (State, Window, Tray, IPC vb.)
  - Frontend: ES Modules yapısına geçiş
  - Daha temiz ve bakımı kolay kod tabanı

### ✨ Yeni Özellikler & İyileştirmeler
- **Favori Sıralama**: Favoriler listesinde sürükle-bırak ile sıralama özelliği
- **Güvenlik**: Hassas dosyalar temizlendi ve .gitignore güncellendi
- **Installer Bilgileri**: Kurulum ekranı için detaylı özellik açıklamaları

### 🐛 Hata Düzeltmeleri
- **UI Düzeltmesi**: Ayarlar menüsündeki Video Kalitesi seçiminde yaşanan görünürlük sorunu (beyaz yazı) giderildi
- **Pano İzleyici**: Başlangıçta yaşanan `startClipboardWatcher` hatası düzeltildi
- **Build**: Dosya paketleme ayarları optimize edildi


## [2.2.0] - 2026-01-14

### ✨ Yeni Özellikler
- **Otomatik Güncelleme Sistemi**: Yeni versiyonlar artık otomatize edildi
  - 10 saniye içinde otomatik kontrol
  - Modern güncelleme bildirim dialogu
  - Progress bar ile indirme takibi
  - Tek tıkla güncelleme ve yeniden başlatma

- **Blur (Bulanıklaştırma) Aracı**: Hassas bilgileri gizlemek için yeni blur tool eklendi
  - 10x10 pixelation efekti
  - Gerçek zamanlı önizleme
  - Yüzler, kişisel veriler ve hassas bilgiler için ideal

- **Daraltılabilir Renk Paleti**: Renk seçenekleri artık toggle butonu ile açılıp kapanabiliyor
  - Daha az yer kaplıyor
  - Smooth animasyon
  - Varsayılan olarak kapalı

### 🎨 Tasarım İyileştirmeleri
- **Modern SVG İkonlar**: Tüm emoji ikonlar profesyonel SVG ikonlara dönüştürüldü
  - Outline stil (içi boş, tutarlı görünüm)
  - Daha keskin ve modern
  - Renk değişimlerine duyarlı

- **Kompakt Toolbar**: Araç çubuğu daha az yer kaplıyor
  - Buton boyutları optimize edildi (28px)
  - Gap azaltıldı (3px)
  - %12.5 daha kompakt

- **Belirgin Kopyala/Kaydet Butonları**: Ana aksiyonlar daha görünür
  - Daha büyük boyut (32px)
  - Mor tonlu arka plan
  - Hover efekti ile vurgu

### ⚡ Performans İyileştirmeleri
- **Hızlı Kopyalama**: Kopyalama işlemi %80 daha hızlı
  - PNG → JPEG 0.95 formatı (3-5x hızlı encoding)
  - Window kapanma gecikmesi 500ms → 100ms
  - Daha küçük dosya boyutu

### 🐛 Hata Düzeltmeleri
- **Kaydetme Davranışı**: Kaydetme penceresini iptal edince artık çizimler kaybolmuyor
  - İptal edince snipper açık kalıyor
  - Çizimler korunuyor
  - Sonra kopyalama yapılabiliyor

- **Kopyala Butonu**: Tıklayınca arka plan rengi artık değişmiyor
  - Daha temiz görünüm
  - Gereksiz görsel geri bildirim kaldırıldı

### 📝 Teknik Detaylar
- Canvas birleştirme algoritması iyileştirildi
- Alpha channel desteği eklendi
- IPC gecikmesi optimize edildi
- Blur fonksiyonu için performans iyileştirmeleri

---

## [2.1.1] - Önceki Sürüm
- Temel ekran görüntüsü özellikleri
- OCR desteği
- Video kayıt
- Pano yönetimi
