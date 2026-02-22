# Changelog

## [2.5.1] - 2026-02-23

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
