# Auto-Update Test Senaryosu

Bu dosya, yeni release çıkarmadan auto-update sistemini test etmek için kullanılacak.

## Test Yöntemi: Dev-App-Update.yml ile Simülasyon

electron-updater'ın geliştirme modunda test edilmesi için `dev-app-update.yml` dosyası kullanılır.

## Adım 1: Test Konfigürasyonu Oluştur

`dev-app-update.yml` dosyası oluşturup root dizine koy:

```yaml
provider: generic
url: http://localhost:5000
```

## Adım 2: Test Sunucusu Hazırla

1. **Test klasörü oluştur:**
   ```bash
   mkdir test-update-server
   cd test-update-server
   ```

2. **Sahte latest.yml oluştur:**
   ```yaml
   version: 2.3.0
   files:
     - url: CopyBoard-Setup-2.3.0.exe
       sha512: [herhangi bir hash]
       size: 100000000
   path: CopyBoard-Setup-2.3.0.exe
   sha512: [herhangi bir hash]
   releaseDate: '2026-01-15T00:00:00.000Z'
   ```

3. **Basit HTTP sunucusu başlat:**
   ```bash
   # Python ile
   python -m http.server 5000
   
   # veya Node.js ile
   npx http-server -p 5000
   ```

## Adım 3: Main.js'i Test Modu için Güncelle

`main.js` içinde auto-update kontrolünü geçici olarak değiştir:

```javascript
// Test için geliştirme modunda da çalışsın
if (app.isPackaged || process.env.NODE_ENV === 'development') {
  setTimeout(() => {
    console.log('Checking for updates...');
    autoUpdater.checkForUpdates();
  }, 3000);
}
```

## Adım 4: Uygulamayı Başlat ve Test Et

```bash
npm start
```

## Alternatif: UI Testi (Daha Kolay)

Dialog'u doğrudan test etmek için:

1. **Test butonu ekle** (geçici olarak `index.html`'e):
   ```html
   <button onclick="window.api.checkForUpdates()">Güncelleme Kontrol Et</button>
   ```

2. **Mock update dialog göster** (`main.js`'e geçici kod):
   ```javascript
   // Test için manuel dialog açma
   ipcMain.on('test-update-dialog', () => {
     createUpdateWindow({
       version: '2.3.0',
       releaseNotes: '## Yenilikler\n- Test özelliği 1\n- Test özelliği 2'
     });
   });
   ```

## Beklenen Sonuçlar

✅ Uygulama açıldıktan 3 saniye sonra güncelleme kontrolü yapılmalı
✅ Yeni versiyon bulunursa modern dialog açılmalı
✅ Dialog'da versiyon numaraları doğru görünmeli
✅ "Şimdi Güncelle" butonu çalışmalı
✅ Progress bar animasyonları akıcı olmalı

## Önemli Notlar

- ⚠️ Test sonrası `dev-app-update.yml` dosyasını SİL
- ⚠️ Test kodlarını production'a göndermeden önce KALDIR
- ✅ Gerçek test için v2.3.0 release yapıp v2.2.0'dan güncelleme dene
