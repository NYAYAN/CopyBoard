# CopyBoard v2.9.1 - İlk Ekran Görüntüsü Düzeltmesi + Performans 📸⚡

Bu sürüm, macOS'ta uygulama açıldıktan sonraki ilk ekran görüntüsünün panoya **siyah** yapışmasını gideriyor ve genel performansı belirgin şekilde iyileştiriyor.

## 📸 İlk çekim artık siyah yapışmıyor
- Şimdiye kadar ilk ekran görüntüsünde alan seçimi ve ok/çizim ekleme **tamamen normal görünüyor**, ama kopyalanan resim yapıştırıldığında **siyah bir dikdörtgen** (üzerinde yalnızca çizimler) çıkıyordu. İkinci çekim hep düzgündü.
- Sebep: macOS, oturumun ilk ekran yakalama çağrısında henüz hazır olmayan **boş bir kare** verebiliyor. Boş görüntü ekran katmanına çizilemiyordu; seçim penceresi saydam olduğu için altındaki **canlı masaüstü** görünüyor ve hata kopya yapıştırılana kadar fark edilmiyordu.

## 🔄 Kendi kendini iyileştirme — uyarı değil, çözüm
- Boş kare gelirse uygulama çekimi **kendisi yineliyor** (ekran başına 5 deneme, kısa aralıklarla).
- Görüntü yine de kullanılamaz çıkarsa seçim ekranı görünmeden önce **sessizce yeni bir yakalama isteniyor**; kullanıcı bu denemelerin hiçbirini görmüyor, sadece pencere bir-iki saniye geç açılabiliyor.
- Tüm denemeler tükenirse (ör. Ekran Kaydı izni geri alınmışsa) engelleyici bir hata penceresi yerine kısa bir bildirim gösterilip ekran kapatılıyor; uygulama askıda kalmıyor, bir sonraki deneme serbest.
- Son güvenlik ağı: yapıştırıldığında siyah görünecek (tamamen saydam) bir kırpma artık **panoya hiç gönderilmiyor**.

## 🖼️ Görüntünün sessizce silinmesi engellendi
- Yakalama yüklendikten sonra pencere boyutu değişirse ekran görüntüsü, çizimler ve geri-al geçmişi **sessizce siliniyordu** (saydam pencere yüzünden yine fark edilmeden). Görüntü artık bellekte tutuluyor ve gerektiğinde yeniden çiziliyor.
- Aynı düzeltme **OCR** ve **ekran kaydı bölge seçimine** de uygulandı.

## ⚡ Genel Performans
- **Geçmiş diske toplu yazılıyor:** her kopyalama tüm ayar dosyasını senkron yazdırıyordu; yazmalar artık birleştiriliyor, çıkışta/uykuda anında işleniyor. **Saklanan veride hiçbir değişiklik yok.**
- **Gizli pencerelere veri gönderilmiyor:** her kopyalamada ~0,5MB geçmiş 3 pencereye birden gidiyordu; artık yalnızca görünür olanlara gidiyor, gizli pencereler açılırken güncel listeyi kendileri çekiyor.
- **Bildirimler (toast) hafifledi:** her bildirim için yeni pencere/süreç açılmıyor, tek pencere yeniden kullanılıyor.
- **OCR belleği geri veriliyor:** metin tanıma motoru 5 dk kullanılmayınca kapatılıyor (150MB+ RAM geri gelir); sonraki tarama 1-2 sn ısınma öder.
- **Liste satırları tek satır:** her öğe tek satırda üç nokta ile gösteriliyor; imleç satırda **yarım saniye** durunca içeriğin geniş hali araç ipucu olarak açılıyor. Liste açılışı ve kaydırma belirgin hafifledi. Kopyalama ve arama her zaman tam içerikle çalışır.
- **1MB'dan büyük metin kopyaları geçmişe alınmaz:** ya bütün ya hiç — kesilerek saklama yapılmaz, pano işleyişi etkilenmez.

## 🧭 Arayüz
- **Bildirimler artık kırpılmıyor:** uzun uyarıların (ör. Erişilebilirlik izni mesajı) son satırları görünmüyordu; bildirim penceresi artık metnin boyuna göre uzayıp kısalıyor.
- **"+" (Manuel Ekle) kaldırıldı;** yerine başlıkta **Geçmiş** düğmesi: galeri veya ayarlardayken tek tıkla geçmiş listesine dönersiniz.
- **Widget'taki geçmiş, ana pencereyle aynı tasarımda:** tek satır metin + sağda tarih-saat, aynı araç ipucu davranışı.

## 🖥️ Windows
- Boş ilk kare macOS'a özgü bir durum; Windows'ta davranış pratikte değişmedi (aynı korumalar orada da devrede). Performans iyileştirmeleri iki platformda da geçerli.

## 📦 Kurulum & Güncelleme
1. CopyBoard-Setup-2.9.1.exe (Windows) veya CopyBoard-2.9.1.dmg (macOS) dosyasını indirip kurun; veya
2. Açık uygulamada otomatik güncelleme bildirimiyle geçin.

---
**Tam Değişiklik Listesi:** [CHANGELOG.md](CHANGELOG.md)
