# CopyBoard

Gelişmiş pano yöneticisi, ekran görüntüsü aracı ve OCR (Resimden Yazıya Çevirme) uygulaması.

![Version](https://img.shields.io/badge/version-2.2.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-ISC-green)

## ✨ Özellikler

### 📋 Pano Yönetimi
- **Otomatik Geçmiş:** Kopyalanan tüm metinleri otomatik saklar
- **Favoriler:** Önemli öğeleri favorilere ekleyin
- **Hızlı Erişim:** `Alt+V` ile anında açılır
- **Özelleştirilebilir:** Geçmiş limiti ayarlanabilir

### 📸 Ekran Görüntüsü Araçları
- **Çizim Araçları:**
  - ✏️ Kalem - Serbest çizim
  - ⬜ Kare - Dikdörtgen çizimi
  - ⭕ Yuvarlak - Daire/elips çizimi
  - 📝 Metin - Metin ekleme
  - ➡️ Ok - Ok işareti çizimi
  - 🌫️ **YENİ: Blur** - Hassas bilgileri bulanıklaştırma

- **Renk Seçenekleri:** 6 farklı renk (daraltılabilir palet)
- **Geri Al:** Çizimleri geri alabilme
- **Hızlı Kopyalama:** %80 daha hızlı kopyalama
- **Kaydetme:** PNG formatında kaydetme

### 🔍 OCR (Optik Karakter Tanıma)
- Ekrandan seçilen alandaki yazıyı otomatik tanır
- Türkçe ve İngilizce dil desteği
- Tanınan metin otomatik panoya kopyalanır

### 🎥 Video Kayıt
- Ekran kaydı yapabilme
- Yüksek/Orta/Düşük kalite seçenekleri
- WebM formatında kaydetme

## ⌨️ Kısayollar

| Kısayol | İşlev |
|---------|-------|
| `Alt+V` | Pano listesini göster |
| `Alt+9` | Ekran görüntüsü al (çizim araçları) |
| `Alt+8` | Video kaydı başlat |
| `Alt+2` | OCR (metin tanıma) |
| `Ctrl+Z` | Geri al (çizim modunda) |
| `ESC` | Ekran görüntüsü modundan çık |

> 💡 **Not:** Kısayollar uygulama ayarlarından özelleştirilebilir.

## 🚀 Hızlı Başlangıç

### Kullanıcılar İçin
1. [Releases](https://github.com/NYAYAN/CopyBoard/releases) sayfasından en son sürümü indirin
2. `CopyBoard-Setup-2.2.0.exe` dosyasını çalıştırın
3. Kurulum sihirbazını takip edin
4. Uygulama otomatik başlayacaktır

### Geliştiriciler İçin

```bash
# 1. Gerekli paketleri yükle
npm install

# 2. Uygulamayı test et (Geliştirici Modu)
npm start

# 3. Setup dosyası oluştur
npm run dist
```

---

## 📦 Detaylı Kurulum (Geliştiriciler)

### Gereksinimler
- **Node.js** (v16 veya üzeri)
- **npm** (Node.js ile birlikte gelir)

### Adımlar

1. **Bağımlılıkları yükleyin:**
   ```bash
   npm install
   ```

2. **Geliştirme modunda çalıştırın:**
   ```bash
   npm start
   ```

3. **Portable versiyon oluşturun:**
   ```bash
   npx electron-packager . CopyBoard --platform=win32 --arch=x64 --icon=icon.png --overwrite
   ```
   Çıktı: `CopyBoard-win32-x64` klasörü

4. **Setup dosyası oluşturun:**
   ```bash
   npm run dist
   ```
   Çıktı: `dist/CopyBoard Setup 2.2.0.exe`

### ⚠️ Setup Oluşturma Notları

Setup dosyası oluşturmak için **PowerShell'i Yönetici olarak çalıştırmalısınız**:

1. Başlat menüsünde "PowerShell" yazın
2. Sağ tıklayıp **"Yönetici olarak çalıştır"** seçin
3. Proje klasörüne gidin:
   ```bash
   cd d:\Work\Other\CopyBoard
   ```
4. Build komutunu çalıştırın:
   ```bash
   npm run dist
   ```

## 🎯 Kullanım İpuçları

### Blur (Bulanıklaştırma) Nasıl Kullanılır?
1. `Alt+9` ile ekran görüntüsü modunu açın
2. Görüntü alanını seçin
3. Blur butonuna (🌫️) tıklayın
4. Bulanıklaştırmak istediğiniz alanı dikdörtgen olarak çizin
5. Alan otomatik olarak pixellenip bulanıklaşacaktır
6. Kopyala veya Kaydet butonuna basın

### Renk Paleti
- Renk butonu (🎨) ile paleti açın/kapatın
- Varsayılan olarak kapalıdır (daha az yer kaplar)
- 6 farklı renk seçeneği

### Kaydetme İpucu
- Kaydet penceresini iptal ederseniz çizimleriniz kaybolmaz
- İptal ettikten sonra kopyalama yapabilirsiniz

## 🆕 Sürüm 2.2.0 Yenilikleri

### ✨ Yeni Özellikler
- 🌫️ **Blur Tool**: Hassas bilgileri bulanıklaştırma aracı
- 🎨 **Daraltılabilir Renk Paleti**: Toggle ile açılıp kapanan renk seçenekleri

### 🎨 Tasarım İyileştirmeleri
- Modern SVG ikonlar (emoji yerine)
- %12.5 daha kompakt toolbar
- Daha belirgin Kopyala/Kaydet butonları

### ⚡ Performans
- %80 daha hızlı kopyalama
- JPEG 0.95 formatı ile optimize edilmiş encoding

### 🐛 Hata Düzeltmeleri
- Kaydetme iptalinde çizimlerin kaybolması düzeltildi
- Kopyala butonunda gereksiz renk değişimi kaldırıldı

Detaylı değişiklikler için: [CHANGELOG.md](CHANGELOG.md)

## 🛠 Teknolojiler

- **Electron** - Desktop uygulama framework
- **Tesseract.js** - OCR motoru
- **electron-store** - Veri saklama
- **HTML/CSS/JavaScript** - UI

## 📝 Lisans

ISC License

## 👤 Yapımcı

**Nurullah YAYAN**
- 📧 nurullah.yayan@gmail.com
- 🐙 [GitHub](https://github.com/NYAYAN)

## 🤝 Katkıda Bulunma

1. Bu repository'yi fork edin
2. Feature branch oluşturun (`git checkout -b feature/AmazingFeature`)
3. Değişikliklerinizi commit edin (`git commit -m 'Add some AmazingFeature'`)
4. Branch'inizi push edin (`git push origin feature/AmazingFeature`)
5. Pull Request oluşturun

## 🐛 Hata Bildirimi

Hata bulursanız veya öneriniz varsa [Issues](https://github.com/NYAYAN/CopyBoard/issues) sayfasından bildirebilirsiniz.

---

⭐ Bu projeyi beğendiyseniz yıldız vermeyi unutmayın!
