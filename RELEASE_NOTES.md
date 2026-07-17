# CopyBoard v2.8.5 - Kısayol & Hızlı Yapıştır Düzeltmeleri 🔧

Bu sürüm iki kısayol sorununu gideriyor.

## ⚡ Hızlı Yapıştır bazı bilgisayarlarda açılmıyordu
- **Neden:** Hızlı Yapıştır kısayolu (Ctrl+Shift+V) başka bir uygulama tarafından kullanılıyorsa kayıt sessizce başarısız oluyor, tuşa basınca hiçbir şey olmuyor ve bir uyarı da verilmiyordu. Bu yüzden yalnızca o çakışmanın olduğu bilgisayarlarda açılmıyordu.
- **Düzeltme:** Kısayol kaydedilemediğinde artık açıklayıcı bir bilgi mesajı gösteriliyor. Ayrıca **tepsi (tray) menüsüne "Hızlı Yapıştır" seçeneği eklendi** — kısayol hangi sebeple olursa olsun çalışmasa bile pencereyi buradan her zaman açabilirsiniz.

## 🍎 macOS: Ekran görüntüsü için Cmd+C çalışmıyordu
- **Neden:** Cmd+C (ve Ctrl+C / Cmd+V gibi sistem Kopyala/Kes/Yapıştır tuşları) genel (global) bir kısayol olarak çalışamaz; ya öndeki uygulama tuşu yakalar ya da sistemin kopyalama işlevini bozar. Uygulama bu geçersiz kısayolu sessizce kabul ediyordu.
- **Düzeltme:** Bu tür kısayollar artık reddediliyor ve sizi geçerli bir kombinasyona yönlendiriyor ("Alt veya Shift ekleyin"). Daha önce kaydedilmiş böyle bir kısayol varsa, açılışta otomatik olarak varsayılana (Ekran Görüntüsü = Alt+9) döndürülür.
- **İpucu:** macOS'ta ekran görüntüsü için Cmd+C yerine Alt içeren bir kısayol kullanın (ör. Alt+9 veya Cmd+Shift+…).

## 📦 Kurulum & Güncelleme
1. CopyBoard-Setup-2.8.5.exe dosyasını indirip kurun; veya
2. Açık uygulamada otomatik güncelleme bildirimiyle geçin.

---
**Tam Değişiklik Listesi:** [CHANGELOG.md](CHANGELOG.md)
