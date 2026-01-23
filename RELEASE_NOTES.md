# CopyBoard v2.3.0 - Modular Architecture & Security Update 🏗️🔒

## 🏗️ Mimari Değişiklikler (Modular Refactoring)

CopyBoard altyapısı, daha sürdürülebilir, güvenli ve genişletilebilir olması için tamamen yenilendi:
- **Backend (Main Process):** Monolitik yapıdan servis tabanlı (Service-Oriented) mimariye geçildi.
  - `state.js`, `window-manager.js`, `tray-manager.js`, `ipc-handlers.js`, `history-manager.js` vb.
- **Frontend (Renderer Process):** Modern **ES Modules** yapısına geçildi, kod okunabilirliği ve performansı artırıldı.
- **Güvenlik:** Hassas dosyalar repodan temizlendi, `.gitignore` güncellendi.
- **Build Optimizasyonu:** `electron-builder` ayarları optimize edildi, gereksiz dosyalar paketten çıkarıldı.

## ✨ Yeni Özellikler & İyileştirmeler

### ⭐ Favori Sıralama (Drag & Drop)
- Favoriler listesindeki öğeleri artık **sürükle-bırak** yöntemiyle dilediğiniz gibi sıralayabilirsiniz.

### 📝 Detaylı Kurulum Bilgileri
- Kurulum sihirbazına (Installer) uygulamanın tüm özelliklerini ve kısayollarını anlatan detaylı bir bilgilendirme ekranı eklendi.

### 🐛 Hata Düzeltmeleri
- **Video Kalite Ayarı:** Ayarlar ekranındaki video kalitesi (Yüksek/Orta/Düşük) seçeneklerinin görünmemesi (beyaz yazı) sorunu giderildi.
- **Başlangıç Hatası:** Nadiren görülen `startClipboardWatcher` hatası giderildi.
- **Video Kayıt:** Kayıt sürecindeki kararlılık artırıldı.

## 📦 Kurulum

1. `CopyBoard-Setup-2.3.0.exe` dosyasını indirin.
2. Kurulum sihirbazını takip edin.
3. Uygulamayı başlatın.

### Otomatik Güncelleme
Eski bir sürümü kullanıyorsanız, uygulamayı açtığınızda otomatik olarak yeni sürümü algılayacak ve güncelleme isteyecektir.

## ⌨️ Kısayollar (Hatırlatma)

- **Alt+V**: Pano listesini göster
- **Alt+9**: Ekran görüntüsü al (Çizim & Blur)
- **Alt+8**: Video kaydet
- **Alt+2**: OCR (Resimden yazı okuma)
- **Ctrl+C**: (Snipping modunda) Görüntüyü kopyala

---

**Tam Değişiklik Listesi**: [CHANGELOG.md](CHANGELOG.md)
