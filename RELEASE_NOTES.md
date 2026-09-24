# CopyBoard v2.13.1 - Yüzen widget görev çubuğu yanında 🎯

Yüzen widget ekranın altına, görev çubuğunun yanına yaklaştırılınca yarım görünüyor,
menüsü açılırken bir an yukarı sıçrıyor ve sürüklenirken görev çubuğunun altına
giriyordu. Hepsi düzeltildi.

## 🎯 Yüzen widget

- **Görev çubuğu yanında düğme tam görünüyor.** Düğmenin altında yer kalmayınca
  paneller yukarı açılıyor; o durumda düğmenin yalnız alt ~12 pikseli görünüyor,
  yukarı açılan menü ve geçmiş paneli ise tamamen görünmez kalıyordu.
- **Menü açılırken flaş yok.** Yukarı açılırken düğme bir an ~340 px yukarıda
  görünüyor, kapanırken bir an kayboluyordu. Artık açıp kapamak yalnız menüyü
  gösterip gizliyor; düğme yerinden oynamıyor.
- **Sürüklerken görev çubuğunun altına girmiyor.** Düğmenin yarısı sürükleme boyunca
  görev çubuğunun altında kalıyor, bırakınca yukarı zıplıyordu. Yan monitöre
  sürüklemek eskisi gibi çalışıyor.
- **Menü açıkken sürüklemek zıplatmıyor.** Yukarı açılan menü açıkken sürükleyince
  widget bırakıldığı yerin ~340 px yukarısına atlıyordu. Sürükleme başlayınca menü
  kapanıyor, düğme imlecin altında kalıyor.
- **Ekranın öbür yarısına ya da görev çubuğunun yanına bırakınca sıçrama yok.** Düğme
  bir an ~350 px yanda görünüyordu; artık bir an solup aynı yerde geri geliyor.
- **Bırakır bırakmaz tıklamak çalışıyor.** Görev çubuğu yanına bırakıp fareyi
  oynatmadan tıklayınca tıklama alttaki uygulamaya gidiyordu.
- **Geçmiş panelinin kenarı kırpılmıyor.** Panelin 10 pikseli pencerenin dışında
  kalıyordu.

---

**Kurulum:** Windows için `CopyBoard-Setup-2.13.1.exe`, macOS için `.dmg` dosyasını
indirin.
