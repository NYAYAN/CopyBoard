# CopyBoard v2.13.0 - Güncelleme ekranı ve metin aracı 🔄📝

Güncelleme ekranı artık sürümünü söylüyor, ve ekran görüntüsü metin aracı yazdığınız
rengi gösteriyor.

## 🔄 Güncelleme ekranı

- **Sürüm bilgisi artık geliyor.** Ekran "Mevcut Versiyon: -" / "Yeni Versiyon: -" ve
  sonsuza kadar "Yükleniyor..." diye açılıyordu. Ana süreç bilgiyi pencere daha kendi
  betiğini çalıştırmadan yolluyordu (`ready-to-show`, sayfanın `did-finish-load`'ından
  ~23 ms önce geliyor), mesaj düşüyordu ve ikinci bir deneme yoktu. Pencere artık
  yüklenir yüklenmez bilgiyi kendisi çekiyor; push da dinleyiciler kurulduktan sonra
  atılıyor.
- **Yuvarlak köşelerin dışındaki beyaz çentik gitti.** Pencere saydam açılıyor ama
  zemini opak bırakılmıştı, 16px'lik yarıçapın dışında kalan üçgenler o renkle
  doluyordu. Zemin şeffaf, kart opak.

## 📝 Ekran görüntüsünde metin aracı

- **Yazı seçili renkte görünüyor.** Kutu beyaz yazı gösterip kırmızı çiziyordu.
  Paletten renk değiştirdiğinizde yazmakta olduğunuz metin de anında o renge dönüyor.
- **Kutu tıklamayla yerinden oynamıyor.** Yazarken ekrana tıklamak kutuyu oraya
  taşıyordu; artık yalnızca sol üstteki `☰` tutamacı taşıyor.
- **`Enter` alt satıra geçiyor**, metni işlemiyor.
- **Onay ve iptal ikon düğmeleri**, kutunun dışında sağ altta: `✓` işler, `✕` vazgeçer
  (`Escape` de vazgeçiyor). Hover'da `✓` koyulaşıyor, `✕` danger rengine dönüyor.

---

**Kurulum:** Windows için `CopyBoard-Setup-2.13.0.exe`, macOS için `.dmg` dosyasını
indirin.
