# Release v2.3.0 - Adım Adım Kılavuz

## 1️⃣ Git Commit ve Push

```bash
# Tüm değişiklikleri stage'e al
git add .

# Commit oluştur
git commit -m "Release v2.3.0: Modular Architecture, Security Fixes, and UI Improvements"

# Ana branch'e push et
git push origin main
```

## 2️⃣ Git Tag Oluştur

```bash
# Tag oluştur
git tag -a v2.3.0 -m "Version 2.3.0 - Modular Architecture & Refactoring"

# Tag'i push et
git push origin v2.3.0
```

## 3️⃣ Build Oluştur

### Windows Setup Dosyası
```bash
# PowerShell'i Yönetici olarak aç ve şunu çalıştır:
npm run dist
```

Çıktı: `dist/CopyBoard Setup 2.3.0.exe`

## 4️⃣ GitHub Release Oluştur

1. GitHub'da repository'ye git: https://github.com/NYAYAN/CopyBoard
2. "Releases" sekmesine tıkla
3. "Draft a new release" butonuna tıkla
4. Tag olarak `v2.3.0` seç
5. Release title: `v2.3.0 - Modular Architecture & Security Update 🏗️🔒`
6. Description kısmına `RELEASE_NOTES.md` içeriğini yapıştır
7. **ÖNEMLİ**: Aşağıdaki dosyaları sürükle-bırak ile ekle:
   - `CopyBoard Setup 2.3.0.exe` (dist klasöründe)
   - `latest.yml` (dist klasöründe - otomatik güncelleme için gerekli)
8. "Publish release" butonuna tıkla

> **Not**: `latest.yml` dosyası electron-builder tarafından otomatik oluşturulur ve auto-update sisteminin çalışması için gereklidir. Bu dosyayı mutlaka release'e ekleyin!

## 5️⃣ Release Notes İçeriği

`RELEASE_NOTES.md` dosyasını GitHub release description'a kopyala.

## ✅ Kontrol Listesi

- [ ] package.json versiyonu 2.3.0 olarak güncellendi
- [ ] CHANGELOG.md güncellendi
- [ ] RELEASE_NOTES.md güncellendi
- [ ] README.md güncellendi
- [ ] Gereksiz dosyalar gitignore'a eklendi ve repodan temizlendi
- [ ] Git commit yapıldı
- [ ] Git tag oluşturuldu ve push edildi
- [ ] Build oluşturuldu (npm run dist)
- [ ] GitHub release oluşturuldu
- [ ] Setup dosyası release'e eklendi

## 📝 Notlar

- Build işlemi ilk seferde NSIS indireceği için 2-3 dakika sürebilir
- PowerShell'i mutlaka Yönetici olarak çalıştırın
- Setup dosyası `dist/` klasöründe oluşacaktır
- Tag'i push etmeden önce commit'lerin push edildiğinden emin olun
