# Changelog

## [2.2.0] - 2026-01-14

### ✨ Yeni Özellikler
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
