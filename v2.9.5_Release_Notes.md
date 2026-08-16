# CopyBoard v2.9.5 - OCR Düzeltmesi ve Hızlı Yapıştır Düğmesi 🔤📋

Metin tarama yeniden çalışıyor, hızlı yapıştırma parola alanlarında da kullanılabiliyor.

## 🔤 Metin Tara (OCR) yeniden çalışıyor
- Önceki sürümde **her tarama hata veriyordu** (`Only absolute URLs are supported`) — Windows ve macOS'ta aynı şekilde. Düzeltildi.
- Tarama tamamen **çevrimdışı**: dil verisi uygulamayla birlikte geliyor, internet gerekmiyor.
- Bir tarama ters giderse uygulama kendini toparlıyor; OCR'ı geri getirmek için artık uygulamayı yeniden başlatmanız gerekmiyor.
- Hız: ilk tarama ~0,7 saniye, sonraki taramalar ~0,4 saniye.

## 📋 Hızlı Yapıştır artık widget menüsünde
- Widget menüsüne **Hızlı Yapıştır** düğmesi eklendi.
- macOS'ta bir **parola alanı** odaktayken sistem klavyeyi o uygulamaya kilitler ve kısayollar çalışmaz. Bu düğme faresle çalıştığı için panel o durumda da açılıyor.
- Seçtiğiniz öğe, widget'a gelmeden önce yazmakta olduğunuz uygulamaya yapıştırılıyor.
- Windows'ta da düğme, arkadaki uygulamaya doğru yapıştırıyor.
- Ayarlardaki Hızlı Yapıştır satırının açıklaması bu durumu ve alternatifleri anlatıyor.

## 📐 Widget menüsü
- Menü, altıncı düğmeyi de tam gösterecek şekilde büyüdü — önceden son öğe kırpılıyordu.

## 📦 Kurulum & Güncelleme
1. CopyBoard-Setup-2.9.5.exe (Windows) veya CopyBoard-2.9.5-arm64.dmg (macOS) dosyasını indirip kurun; veya
2. Açık uygulamada otomatik güncelleme bildirimiyle geçin.

---
**Tam Değişiklik Listesi:** [CHANGELOG.md](CHANGELOG.md)
