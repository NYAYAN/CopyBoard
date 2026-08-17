# CopyBoard v2.11.0 - Kaydırmalı Yakalama 📜

Ekrana sığmayan bir sayfayı tek görüntüde yakalayın. Yanında da bu haftanın düzeltmeleri.

## 📜 Kaydırmalı yakalama

Uzun bir sayfayı parça parça almak yerine tek bir görüntü olarak alın.

- Alanı seçin, **Başlat**'a basın ve sayfayı **kendiniz kaydırın** — uygulama kareleri
  saniyede ~25 kez örnekleyip örtüşmelerinden birleştirir.
- Kaydırmayı bırakınca kendiliğinden biter; dilerseniz **Bitir** düğmesiyle de kapatabilirsiniz.
- **İki yönlü**: aşağı da yukarı da kaydırabilirsiniz, trackpad'de kaçınılmaz olan
  ileri-geri salınım da sorun çıkarmaz.
- **Yapışkan başlık ve altlıkları tanır**: sabit duran çubuklar birleştirmeye karışmaz,
  sonuçta bir kez, en üstte ve en altta yer alır.
- Hiçbir tuş vuruşu enjekte edilmez, dolayısıyla macOS'ta **Erişilebilirlik izni istemez**.
- Sonucu panoya kopyalayabilir veya dosyaya kaydedebilirsiniz; her ikisi de galeriye düşer.

## 🖼️ Büyük görüntüleyici

- Resim artık pencereye yapışık değil: pencere resimden biraz büyük açılıyor, resim
  **gerçek boyutunda (%100)** kalıyor ve etrafında boşluk oluyor.
- Ekrandan büyük görüntüler eskisi gibi sığdırılarak açılmaya devam ediyor.

## 🖼️ Ekran görüntüleri galerisi

- **Küçük resimler netleşti.** Eskiden kare bir kutuya sığdırılıyorlardı; bu, ekran
  şeklinde olmayan her şeyi eziyordu — uzun bir kaydırmalı yakalama 11 piksel genişliğinde
  bir küçük resme dönüşüyordu. Artık ızgaranın çizdiği şekilde üretiliyorlar.
- Kaydırmalı yakalamaların küçük resmi artık sayfanın **üst kısmını** gösteriyor — bir sayfa
  ortasından değil başlığından tanınır.
- **Galerinizde duran eski kayıtlar da onarılıyor**: uygulama açıldıktan birkaç saniye sonra
  eski küçük resimler diskteki görüntülerden yeniden üretilir.
- Kareler biraz büyüdü; sağdaki dört düğme artık tam sığıyor, **Sil** alt kenarda
  kesilmiyor.
- İlk kare artık sürekli seçili gibi durmuyor: karartma ve düğmeler yalnızca fareyle
  üzerine gelince çıkıyor.

## 💾 Kaydetme

- **Kaydet penceresi artık açılıyor.** Eskiden yakalama kaplamasının arkasında açıldığı için
  görünmüyor, ancak kaplama kapandığında ortaya çıkıyordu — bazen bambaşka bir işin
  ortasında.
- Düğme çalıştığını gösteriyor: büyük bir sayfayı PNG'ye çevirmek saniyeler sürüyor,
  bu sürede düğmede dönen bir gösterge var ve pencere gerçekten açıldığında duruyor.
- Üst üste basmak artık birden fazla kaydetme penceresi açmıyor.

## 📦 Kurulum & Güncelleme

1. CopyBoard-Setup-2.11.0.exe (Windows) veya CopyBoard-2.11.0-arm64.dmg (macOS) dosyasını
   indirip kurun; veya
2. Açık uygulamada otomatik güncelleme bildirimiyle geçin.

---
**Tam Değişiklik Listesi:** [CHANGELOG.md](CHANGELOG.md)
