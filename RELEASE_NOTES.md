# CopyBoard v2.8.7 - macOS'ta Hızlı Yapıştır Düzeltmesi ⌨️🍎

Bu sürüm, macOS'ta Hızlı Yapıştır'ın seçilen öğeyi metin alanına yapıştırmamasını gideriyor.

## ⚡ Hızlı Yapıştır artık macOS'ta da yapıştırıyor
- Şimdiye kadar macOS'ta Hızlı Yapıştır panelinden bir öğe seçtiğinizde öğe **panoya kopyalanıyor ama odaktaki metin alanına yazılmıyordu**. Tuş vuruşunu gönderen bölüm yalnızca Windows için yazılmıştı; macOS tarafı hiç uygulanmamıştı. Artık macOS'ta da yapıştırma gerçekleşiyor.
- Panel açılırken **önde olan uygulama hatırlanıyor** ve yapıştırma anında yeniden öne alınıyor. Böylece panele tıklamanın odağı kaydırdığı durumlarda seçtiğiniz metin yanlış pencereye gitmiyor.

## 🔐 İzin akışı elle uğraştırmıyor
- macOS'ta başka bir uygulamaya tuş vuruşu göndermek **Erişilebilirlik** izni gerektirir (Windows'ta böyle bir gereksinim yoktur). CopyBoard bu izni artık **kendisi istiyor**: sistemin "Open System Settings" düğmeli penceresi açılıyor, Ayarlar içinde doğru paneli aramanız gerekmiyor. İstem oturum başına yalnızca bir kez gösteriliyor.
- **İzni verdikten sonra CopyBoard'u kapatıp yeniden açın.** macOS, verilen izni zaten çalışmakta olan bir uygulamaya uygulamaz; bu adım atlanırsa izin verilmiş görünse bile yapıştırma çalışmaz.

## 🛡️ Sessiz başarısızlık yok
- İzin verilmemişse ya da yapıştırma herhangi bir sebeple başarısız olursa artık hiçbir şey olmamış gibi davranılmıyor: hangi iznin eksik olduğunu (**Erişilebilirlik** veya **Otomasyon**) belirten bir uyarı gösteriliyor.
- Her durumda seçtiğiniz öğe panoya kopyalanmış oluyor, yani en kötü ihtimalle `Cmd+V` ile elle yapıştırabilirsiniz.

## 🔏 macOS uygulaması artık kendi kimliğiyle imzalanıyor
- macOS paketi şimdiye kadar hiç yeniden imzalanmıyordu ve stok Electron ikilisinin imzasını taşıyordu; yani sistem açısından uygulamanın **kendine ait bir kimliği yoktu**. Bu, macOS izinlerinin yanlış yere bağlanmasına ve Gizlilik ayarlarında birbirinden ayırt edilemeyen "CopyBoard" satırlarına yol açıyordu. Artık paket gerçek kimliğiyle imzalanıyor.
- ⚠️ **macOS'ta bu sürüme geçenler Erişilebilirlik iznini bir kez yeniden vermelidir.** Uygulamanın kimliği değiştiği için macOS eski izni tanımaz. Ayarlar → Gizlilik ve Güvenlik → Erişilebilirlik listesinde eski **CopyBoard** satırı varsa `−` ile kaldırın; yeni izin ilk Hızlı Yapıştır kullanımında istenir.
- Bu bir Developer ID imzası değildir; Gatekeeper uyarısı ve kurulumdaki `xattr` adımı aynı şekilde geçerli.

## 🖥️ Windows
- Windows tarafındaki yapıştırma davranışı ve imzalama akışı bu sürümde değişmedi.

## 📦 Kurulum & Güncelleme
1. CopyBoard-Setup-2.8.7.exe (Windows) veya CopyBoard-2.8.7.dmg (macOS) dosyasını indirip kurun; veya
2. Açık uygulamada otomatik güncelleme bildirimiyle geçin.

---
**Tam Değişiklik Listesi:** [CHANGELOG.md](CHANGELOG.md)
