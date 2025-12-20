# CopyBoard

Gelişmiş pano yöneticisi ve OCR (Resimden Yazıya Çevirme) aracı.

## 🚀 Hızlı Başlangıç (Özet)

Aşağıdaki komutları sırasıyla terminalde çalıştırarak projeyi kurabilir ve .exe haline getirebilirsiniz:

```bash
# 1. Gerekli paketleri yükle
npm install

# 2. Uygulamayı test et (Geliştirici Modu)
npm start

# 3. .EXE (.zip benzeri) paketini oluştur
npx electron-packager . CopyBoard --platform=win32 --arch=x64 --icon=icon.png --overwrite
```

---

## 📦 Detaylı Kurulum

Bu proje **Node.js** ve **Electron** tabanlıdır. Çalıştırmak için bilgisayarınızda Node.js yüklü olmalıdır.

1.  Bu klasörde bir terminal açın.
2.  Bağımlılıkları yüklemek için:
    ```bash
    npm install
    ```

## 🛠 Geliştirme (Test) Modu

Uygulamayı kodlarken veya test ederken çalıştırmak için:

```bash
npm start
```

Bu komut uygulamayı başlatacak ve geliştirici araçları olmadan pencereyi açacaktır.

## 💾 .EXE Oluşturma (Seçenek 1: Klasör / Portable)

Uygulamayı kurulum gerektirmeyen bir klasör olarak çıkarmak için:

```bash
npx electron-packager . CopyBoard --platform=win32 --arch=x64 --icon=icon.png --overwrite
```
Çıktı: `CopyBoard-win32-x64` klasörü.

## 💿 Setup Oluşturma (Seçenek 2: Kurulum Dosyası)

Arkadaşlarınıza gönderip "İleri > İleri > Kur" şeklinde yükletebileceğiniz tek bir `.exe` dosyası oluşturmak için:

### ⚠️ ÖNEMLİ: Yönetici Yetkisi Gereklidir

Setup dosyası oluşturmak için **PowerShell veya VS Code'u Yönetici olarak çalıştırmalısınız**.

#### Adım Adım:
1. **PowerShell'i Yönetici Olarak Açın:**
   - Başlat menüsünde "PowerShell" yazın
   - Sağ tıklayıp **"Yönetici olarak çalıştır"** seçin
   
2. **Proje klasörüne gidin:**
   ```bash
   cd d:\Work\Other\Gravity\CopyBoard
   ```

3. **Setup dosyasını oluşturun:**
   ```bash
   npm run dist
   ```

*Bu işlem ilk seferde internetten gerekli araçları (NSIS) indireceği için birkaç dakika sürebilir.*

**✅ Başarılı olursa:**
- `dist/` klasöründe `CopyBoard Setup 1.0.0.exe` oluşacaktır.

**❌ Hata alırsanız (winCodeSign hatası vb.):**
- VS Code'u kapatın ve yukarıdaki adımları VS Code yerine PowerShell'de deneyin
- Veya portable versiyonu kullanın (Seçenek 1)

## ✨ Özellikler

*   **Pano Geçmişi:** Kopyalanan tüm metinleri saklar (`Alt+Shift+V` ile açılır).
*   **OCR (Resim Okuma):** Ekrandan seçilen alanın görüntüsünü alır ve içindeki yazıyı kopyalar (`Alt+Shift+2`).
*   **Gizli Çalışma:** Uygulama arka planda (System Tray) çalışır.
*   **Özelleştirme:** Kısayollar ve geçmiş limiti değiştirilebilir.

## 👤 Yapımcı

**Nurullah YAYAN**
*   📧 nurullah.yayan@gmail.com
*   📞 541 457 27 39
