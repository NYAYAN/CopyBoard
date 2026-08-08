# CopyBoard v2.9.2 - macOS Tepsi Simgesi Düzeltmeleri 🍎📌

Bu sürüm, macOS menü çubuğundaki CopyBoard simgesiyle ilgili üç sorunu gideriyor.

## 📌 Simgeye tıklayınca pencere açılıyor
- Şimdiye kadar simgeye **sol tıklamak menüyü açıyordu**; pencereyi açmak için menüden ayrıca "Göster" demek gerekiyordu. Artık **sol tık doğrudan pencereyi açıp kapatıyor**, menü **sağ tıkta**.
- Pencere açıkken simgeye tekrar tıklamak onu kapatır.
- Menünün içeriği aynı: Göster, Hızlı Yapıştır, Ekran Görüntüsü Al, Metin Oku (OCR), Video Kaydet, Çıkış. Windows'ta davranış değişmedi.

## 🚫 "Göster" bazen hiçbir şey yapmıyordu
- Tepsiden açılan pencere, macOS odağı önceki uygulamaya geri verirken **kendini anında tekrar gizleyebiliyordu**; tıklama boşa gitmiş gibi görünüyordu. Pencere artık açıldıktan hemen sonra kapanmıyor ve uygulama düzgün şekilde öne alınıyor.

## ⌨️ Menü açıkken basılan kısayollar artık birikmiyor
- Menü açıkken kısayollar (Ekran Görüntüsü, OCR, Hızlı Yapıştır…) **tepki vermiyordu**; menüyü kapatınca o sırada bastığınız her şey **arka arkaya birden tetikleniyordu**. Bunun sebebi macOS'ta yerel menülerin uygulamayı geçici olarak dondurmasıydı.
- Artık menü açıkken kısayollar devre dışı bırakılıyor: basış birikmiyor, menü kapanınca sürpriz bir işlem yığını çalışmıyor. Menü kapanır kapanmaz kısayollar normale dönüyor.

## 📦 Kurulum & Güncelleme
1. CopyBoard-Setup-2.9.2.exe (Windows) veya CopyBoard-2.9.2-arm64.dmg (macOS) dosyasını indirip kurun; veya
2. Açık uygulamada otomatik güncelleme bildirimiyle geçin.

---
**Tam Değişiklik Listesi:** [CHANGELOG.md](CHANGELOG.md)
