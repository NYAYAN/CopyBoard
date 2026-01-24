# CopyBoard v2.3.0

> **Gelişmiş Pano Yöneticisi, Ekran Görüntüsü Aracı ve OCR (Resimden Yazıya Çevirme) Uygulaması**

![Version](https://img.shields.io/badge/version-2.3.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)
![License](https://img.shields.io/badge/license-ISC-green)

CopyBoard, günlük iş akışınızı hızlandırmak ve verimliliğinizi artırmak için tasarlanmış modern bir üretkenlik aracıdır. Pano geçmişinizi yönetin, ekran görüntüleri alın, videolar kaydedin ve resimlerdeki yazıları anında metne dönüştürün.

---

## ✨ Özellikler

### 📋 1. Gelişmiş Pano Yöneticisi
- **Otomatik Kayıt:** Kopyaladığınız her metin otomatik olarak geçmişe kaydedilir.
- **Arama:** Geçmiş kayıtları arasında anında arama yapın.
- **Geçmiş Temizleme:** İşiniz bittiğinde geçmişi tek tıkla temizleyin (Favorileriniz güvende kalır!).

### ⭐ 2. Favoriler ve Notlar
- **Sabitleme:** Sık kullandığınız metinleri "Favoriler" sekmesine ekleyin.
- **Not Ekleme:** Favori öğelerinize özel notlar ekleyerek (örn: "Müşteri Mail Taslağı") içeriği hatırlamanızı kolaylaştırın.
- **Sürükle-Bırak:** Favori listenizi dilediğiniz gibi sürükleyip bırakarak sıralayın.

### 📸 3. Ekran Alıntısı Aracı (Snipping Tool)
- **Hızlı Seçim:** Ekranın dilediğiniz bölümünü seçin.
- **Çizim Araçları:**
  - ✏️ **Kalem:** Serbest çizim yapın.
  - ⬜ **Şekiller:** Kare, Daire ve Ok işaretleri ekleyin.
  - 📝 **Metin:** Görüntü üzerine notlar yazın.
  - 🌫️ **Blur (Bulanıklaştırma):** Hassas bilgileri (şifre, kimlik vb.) sansürleyin.
- **Kopyalama & Kaydetme:** Görüntüyü direkt panoya kopyalayın (`Ctrl+C`) veya PNG olarak kaydedin.

### 🎥 4. Video Ekran Kaydı
- **Esnek Kayıt:** İster tam ekran, isterseniz sadece seçtiğiniz belirli bir alanın videosunu çekin.
- **Format:** WebM formatında yüksek kaliteli kayıtlar alın.
- **Kalite Seçenekleri:** Yüksek, Orta veya Düşük kalite ayarları.

### 🔍 5. Gelişmiş OCR (Optik Karakter Tanıma)
- **Metin Tanıma:** Ekranda gördüğünüz herhangi bir yazıyı (resim, PDF, video karesi vb.) seçerek anında metne dönüştürün.
- **Dil Desteği:** Türkçe ve İngilizce metinleri yüksek doğrulukla tanır.
- **Otomatik Kopyalama:** Tanınan metin otomatik olarak panoya kopyalanır.

### 🔄 6. Otomatik Güncelleme
- Uygulama başlangıcında otomatik güncelleme kontrolü.
- Yeni sürümlerin arka planda indirilmesi ve tek tıkla kurulumu.

---

## ⌨️ Kısayollar

| Kısayol | İşlev | Açıklama |
|---------|-------|----------|
| `Alt / Option + V` | **Pano Listesi** | Pano geçmişi ve favoriler penceresini açar. |
| `Alt / Option + 9` | **Ekran Görüntüsü** | Ekran alıntısı aracını başlatır. |
| `Alt / Option + 8` | **Video Kaydı** | Video kaydı arayüzünü açar. |
| `Alt / Option + 2` | **OCR (Metin Oku)** | Ekrandan metin okuma aracını başlatır. |
| `Ctrl + C` | **Kopyala** | (Snipping Modunda) Seçili alanı panoya kopyalar. |
| `ESC` | **Çıkış** | Aktif araçtan veya pencereden çıkar. |

> **Not:** Kısayollar uygulama ayarlarından özelleştirilebilir.

---

## 🚀 Kurulum (Kullanıcılar İçin)

1. **[Releases](https://github.com/NYAYAN/CopyBoard/releases)** sayfasından işletim sisteminize uygun sürümü indirin:
   - **Windows:** `CopyBoard-Setup-2.3.0.exe`
   - **macOS:** `CopyBoard-2.3.0.dmg`
2. İndirdiğiniz dosyayı çalıştırın (macOS'te uygulamayı `Applications` klasörüne sürükleyin).
3. Kurulum tamamlandığında uygulama otomatik olarak başlayacak ve sistem tepsisine (saat yanı) yerleşecektir.

> **⚠️ macOS Kullanıcıları İçin Önemli Not:**
> Eğer uygulama "Geliştirici doğrulanamadı" veya "Hasarlı" hatası verirse, Terminal'i açıp şu komutu uygulayın:
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/CopyBoard.app
> ```
> *Komutu girdikten sonra şifrenizi girmeniz gerekebilir.*

---

## 🛠 Geliştirici Kılavuzu

Proje modern bir mimariye taşınmış ve modüler hale getirilmiştir.

### Gereksinimler
- **Node.js** (v16+)
- **npm**

### Proje Yapısı (v2.3.0)
```
src/
├── main/              # Backend (Electron Main Process)
│   ├── services/      # Ayrıştırılmış Servisler (State, Window, Tray, IPC vb.)
│   └── main.js        # Ana giriş noktası
├── renderer/          # Frontend (Electron Renderer Process)
│   ├── main-window/   # Ana Pano Arayüzü (ES Modules)
│   ├── snipper/       # Ekran Alıntısı Aracı
│   ├── ocr/           # OCR Aracı
│   └── recorder/      # Video Kaydedici
└── preload/           # Preload Scriptleri
```

### Kurulum ve Çalıştırma

1. **Repoyu klonlayın:**
   ```bash
   git clone https://github.com/NYAYAN/CopyBoard.git
   cd CopyBoard
   ```

2. **Bağımlılıkları yükleyin:**
   ```bash
   npm install
   ```

3. **Geliştirme modunda başlatın:**
   ```bash
   npm start
   ```

4. **Production Build (Setup) oluşturun:**
   ```bash
   npm run dist
   ```
   *Not: Bu işlem `dist/` klasöründe kurulum dosyasını oluşturur.*

---

## 👤 Yapımcı

**Nurullah YAYAN**
- 📧 E-posta: nurullah.yayan@gmail.com
- 🐙 GitHub: [NYAYAN](https://github.com/NYAYAN)

---

## 📝 Lisans

Bu proje **ISC** lisansı ile lisanslanmıştır. Detaylar için `LICENSE` dosyasına bakabilirsiniz.
