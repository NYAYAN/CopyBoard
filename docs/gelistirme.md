# Geliştirme

Kaynaktan çalıştırma, proje yapısı, testler ve paket üretme. Kullanıcı kurulumu için:
[README](../README.md#paketi-indirip-kurmak).

## Gereksinimler
- **Node.js** 18.17+ veya 20+ (CI, Node 18 ile derliyor)
- **npm**
- **macOS için:** Xcode Command Line Tools — `native/mac-hotkey` yerel eklentisi kurulumdan
  sonra derlenir. Derlenemezse kurulum yine de tamamlanır; yalnızca Electron'un
  adlandıramadığı fiziksel tuşlar (Esc altındaki ISO tuşu, JIS tuşları) kısayol olarak
  atanamaz.

## Proje Yapısı
```
src/
├── main/              # Backend (Electron Main Process)
│   ├── services/      # Ayrıştırılmış Servisler (State, Window, Tray, Tema, i18n vb.)
│   │   └── ipc/       # Konularına ayrılmış IPC işleyicileri
│   └── main.js        # Ana giriş noktası
├── renderer/          # Frontend (Electron Renderer Process)
│   ├── main-window/   # Ana Pano Arayüzü (ES Modules + modules/ alt klasörü)
│   ├── widget/        # Yüzen Araç (Floating Widget)
│   ├── quickpaste/    # Hızlı Yapıştır Seçicisi
│   ├── snipper/       # Ekran Alıntısı Aracı (+ renk seçici modu)
│   ├── ocr/           # OCR Aracı
│   ├── recorder/      # Video Kaydedici
│   ├── scroller/      # Kaydırmalı Yakalama (+ birleştirme algoritması)
│   ├── viewer/        # Büyük Ekran Görüntüsü Görüntüleyici
│   ├── update/        # Güncelleme Penceresi
│   ├── toast/         # Bildirim (Toast)
│   └── shared/        # Ortak Varlıklar (tokens.css, i18n, içerik türü, cursor)
├── shared/i18n/       # Çeviri sözlükleri (en.json)
└── preload/           # Preload Scriptleri

native/mac-hotkey/     # macOS yerel kısayol eklentisi (N-API)
scripts/               # Yardımcı betikler (yerel derleme, imzalama, ekran görüntüsü)
test/                  # node:test birim testleri + Electron kontrol betikleri
docs/                  # Kullanım ve geliştirme belgeleri
docs/screenshots/      # README ve belgelerdeki ekran görüntüleri
```

## Kurulum ve Çalıştırma

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

4. **Testleri çalıştırın:**
   ```bash
   npm test
   ```
   *Test betiği `node --test`'in glob desteğini kullandığı için bu adım **Node 21+**
   ister; uygulamanın kendisi 18 ile derleniyor.*

5. **Production Build (Setup) oluşturun:**
   ```bash
   npm run dist
   ```
   *Not: Bu işlem `dist/` klasöründe kurulum dosyasını oluşturur.*

6. **README ve belgelerdeki ekran görüntülerini yeniden üretin:**
   ```bash
   npm run screenshots
   ```
   *Arayüz değiştiğinde `docs/screenshots/` klasörünü baştan yazar; README'nin en
   üstündeki `00-tanitim.png` de diğer ekranların karelerinden bu sırada kurulur. Uygulamanın gerçek
   pencerelerini örnek veriyle açıp yakalar — sizin panonuza, ekran görüntülerinize veya
   ayarlarınıza dokunmaz. Kareler ekranın piksel yoğunluğuyla üretildiği için en iyi
   sonucu Retina/HiDPI bir ekranda verir; satırlardaki saatler her koşuda tazelenir.*
