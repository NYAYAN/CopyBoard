# CopyBoard v2.11.1 Release Notes

Açık temada açılır listelerin okunmaması.

## 🎛️ Seçim listeleri (açık tema)
- **Açık temada hover edilen satırın yazısı kayboluyordu.** Liste sayfanın dışında çiziliyordu — Windows'ta Chromium, macOS'ta sistem menüsü tarafından — ve satır renklerini kontrolden alırken **vurgulanan satırı sistem vurgu rengiyle** boyuyordu. `#18181b` yazı, doygun mavi bir bandın üzerine düşüyordu. CSS ile ulaşılamıyordu: liste sayfada olmadığı için `option:hover` hiç uygulanmıyor. Koyu tema hatayı baştan beri gizliyordu, beyaza yakın yazı aynı mavinin üzerinde okunduğu için.
- `appearance: base-select` (Chromium 135+, uygulama 142 ile geliyor) listeyi sayfanın içine gerçek DOM olarak alıyor; hover, klavye imleci ve seçili satır artık uygulamanın kendi token'larıyla sıradan CSS. Ayrıca iki platformda birebir aynı çiziliyor — düzeltmenin tahminle değil ölçülerek doğrulanabilmesi bu sayede.
- Kurallar yeni **`shared/select.css`** dosyasında, `shared/overlay-tooltip.css` ile aynı desende: kayıt araç çubuğundaki kalite seçicisinde **tıpatıp aynı hata** vardı, o da aynı düzeltmeyi paylaşıyor. Her pencere yalnızca kendi kapalı kontrolünü biçimlendirmeye devam ediyor. UA'nın dolu üçgeni, uygulamanın her yerindeki çizgisel chevron ile değişti.
- `.select` üzerindeki **`max-width: 150px` kaldırıldı.** Yerel kontrol sığmayan değeri kırpıp etikete yerini bırakıyordu; bu kontrol içeriğine göre büyüdüğü için sınır, en uzun değeri (İngilizce video kalitesi, "Medium (1080p - 30fps)") 28px'lik kutudan taşan ikinci satıra sarıyordu. Ellipsis'e düşmek mümkün değil: kapalı değeri UA, hiçbir yazar kuralının erişemediği bir gölge düğmede çiziyor ve `text-overflow` oraya miras kalmıyor. `.set-label` zaten `flex: 1 1 auto; min-width: 0` olduğu için genişliği açıklama emiyor.
- Kayıt araç çubuğu `translateX(-50%)` yerine **otomatik kenar boşluğuyla ortalanıyor.** Dönüştürülmüş bir üst öğe, listenin örtük tutturma noktasının nerede çözüleceğini kaydırıyor ve liste, ait olduğu düğmenin yarım çubuk genişliği sağında açılıyordu. Fare yoksayma bölgesi `getBoundingClientRect` okuduğu için iki yolda da aynı.
- Bilerek **kullanılmayan** şey: yazarın sağladığı `<button><selectedcontent></selectedcontent></button>` işaretlemesi. Kopyası bir kez alınıyor ve bir `<option>`'ın metni değiştiğinde yenilenmiyor; `shared/i18n.js` ise option metinlerini yüklemede yerinde değiştiriyor — kapalı kontrol İngilizce arayüzde Türkçe kalırdı. Ölçüldü: UA'nın kendi düğmesi option'ı canlı takip ediyor, o yüzden kalıyor.
- Doğrulama gerçek ayarlar panelinde ve gerçek kayıt kaplamasında, gerçek boyutlarında sürülerek yapıldı: iki temada da hover okunur, klavye imleci görünür, en uzun İngilizce etiket tek satır, ve tıklama hâlâ `change` tetikleyip `.value`'yu güncelliyor.

---

# CopyBoard v2.11.0 Release Notes

Kaydırmalı yakalama, ve bir haftanın ölçülerek bulunmuş düzeltmeleri.

## 📜 Kaydırmalı yakalama
- Kullanıcı alanı seçiyor, sayfayı **kendisi kaydırıyor**, uygulama saniyede ~25 kare örnekleyip örtüşmelerinden birleştiriyor. Kaydırma enjekte edilmediği için macOS'ta **Erişilebilirlik izni istenmiyor**.
- Boru tesisatının çoğu video kaydından hazır geldi: aynı `getUserMedia` masaüstü akışı, ve `setContentProtection` overlay'i kendi akışımızdan zaten dışlıyor — outline, HUD ve araç çubuğu sonuca baskılanmıyor.
- Eşleştirme kareyi satır başına ~64 luma örneğine indiriyor: 1200x800 bir kare 3.8MB yerine 51KB, ve 2B şablon eşleştirme 1B dizi eşleştirmeye dönüşüyor.
- Gerçek sayfaların üç zorluğunun karşılığı var: **yapışkan başlık/altlık** tespit edilip hem eşleştirme bandından hem eklenen şeritten çıkarılıyor; **tekrarlı içerikte** birden çok offset aynı derecede iyi eşleştiği için kare, kaydırma hızı net bir kazanan göstermedikçe reddediliyor; **bölge boyundan hızlı kaydırmada** hiç örtüşme kalmıyor, o kare reddedilip taban kare tutuluyor, böylece içerik menzile dönünce yakalama kendini toparlıyor.
- **İki yönlü.** Offset araması yalnızca `d >= 0` üzerindeydi — içeriğin yukarı kayması, yani sayfada aşağı inmek. Yukarı kaydırmak negatif offset ürettiği için hiç aday olarak denenmiyor, dolayısıyla yukarı doğru yapılan bir yakalamada **her kare reddediliyordu**. Yön kilidi koymak yerine doğru model kuruldu: yakalanan bölge artık mutlak sayfa koordinatında bir `[capLo, capHi)` aralığı ve kare bu aralığın hangi ucundan taşıyorsa yeni satırlar o uca gidiyor. Yön kendiliğinden çıkıyor; zaten yakalanmış yerin üstünden geçmek hiçbir şey eklemiyor ama nerede olduğumuzu bildiğimiz için taban kare ilerliyor.
- **Araç çubuğu hiç görünmüyordu:** `.hidden` `display: none !important` taşıyor, `placeToolbar` ise satır içi `style.display = 'flex'` ile açmaya çalışıyordu — satır içi değer `!important`'ı yenemez. Sonucu ağır: Başlat düğmesi yok, Bitir düğmesi yok, yani başlayan yakalamadan çıkışın tek yolu global Esc — o da iptal ediyor. Görünürlük artık tamamen sınıf üzerinden.
- **Bitirme sayacı hareketi değil işlenen satırı ölçüyordu.** Hızlı kaydırma örtüşme bırakmadığı için kareler reddediliyor (bu kasıtlı: taban kare tutulup içerik menzile dönünce toparlanıyor) ve o süre boyunca hiçbir satır işlenmiyor. 2,5 saniyelik reddedilen kare, sayfanın sonuna gelmekle birebir aynı görünüyordu — yakalama kullanıcının elinde, sayfanın ortasında bitiyordu. Aynısı **geriye kaydırırken** de oluyordu: o kareler eşleşiyor ama yeni satır getirmiyor. Sayaç artık durgunluğu ölçüyor; bölgenin içinde sürekli değişen bir şey varsa (animasyon, video) durgunluk hiç gelmeyeceği için ayrıca uzun bir tavan var ve o yol sessizce değil notla bitiyor.

## 💾 Kaydetme penceresi
- **Panel gerçekten açılıyordu — kimsenin göremeyeceği yerde.** macOS'ta bilerek ebeveynsiz açılıyordu, yani bir pencereye değil uygulamaya aitti. Yakalama kaplaması uygulamayı hiçbir zaman ön plana getirmiyor (tıklamaları altındaki uygulamaya geçiriyor, üstelik always-on-top ve can-join-all-spaces), dolayısıyla ön planda olmayan bir uygulamanın app-modal paneli ön plandaki uygulamanın pencerelerinin arkasında açılıyordu. Ancak kaplama yıkıldığında ortaya çıkıyordu — Kopyala'ya basınca gelen dosya yolu ekranı buydu. Panel artık kaplamaya bağlı bir **sheet**: ebeveynine yapışık olduğu için arkasına düşemiyor ve hangi uygulamanın aktif olduğu önemli değil.
- **Üst üste basmak birden çok panel açıyordu.** Birleştirilmiş bir sayfayı PNG'ye kodlamak saniyeler sürüyor ve o sırada ekranda hiçbir şey değişmiyordu; her yeni tıklama yeni bir kodlama ve yeni bir panel isteği başlatıyordu. Dışa aktarma düğmeleri artık iş bitene kadar pasif, ana süreç de bir panel açıkken ikincisini reddediyor.
- Basılan düğme ikonunun yerinde **dönen bir gösterge** taşıyor (genişliği sabit kalsın diye `border-box` bir halka) ve gösterge, panelin gerçekten açıldığı anda duruyor: macOS'ta `sheet-begin` 647 ms'de tetikleniyor, `showSaveDialog` çağrısı ise 910 ms'de dönüyor — paneli istemeden önce haber vermek göstergeyi yarım saniye erken durduruyordu.

## 🖼️ Büyük görüntüleyici
- Resim pencereye tam yapışık geliyordu. Sahneye 10px dolgu verildi **ve pencere o kadar büyük açılıyor**, yani boşluk resimden değil pencereden geliyor: 1:1 görünen bir görüntü yine 1:1 görünüyor.
- Pencere ayrıca resmin ~1,25 katı açılıyor, böylece resim sahnenin %80'ini kaplıyor. Öncelik 1:1: ekran 1,25 katına yetmiyorsa boşluktan feragat ediliyor, çünkü bir ekran görüntüsünü %94'e küçültmek yazıları bulanıklaştırır.
- `clientWidth` dolguyu saydığı için `fitScale()` ve `updateZoomable()` içerik kutusunu ölçüyor — düzeltilmese sığdırma, resmin ulaşamayacağı bir ölçek bildirecekti.

## 🖼️ Galeri
- **Küçük resimler ızgaranın çizdiği şekilde üretiliyor.** Kare bir kutuya sığdırmak, ekran şeklinde olmayan her şeyi eziyordu: 766x8175 bir kaydırmalı yakalama 34 piksel, 785x16384 bir sayfa **11 piksel** genişliğinde çıkıyor, `object-fit: cover` da bunları hücrenin 318 pikseline yayıyordu. Artık 360x245'i (hücrenin 159x108 CSS boyutunun iki katı) kaplayacak şekilde ölçekleniyor ve o boyuta kırpılıyor; kırpma üstten, çünkü bir sayfa başlığından tanınıyor. Ölçüm: galerideki şekillerin hepsinde 1,6x–18,7x büyütme sıfıra iniyor.
- **Mevcut kayıtlar açılışta onarılıyor**, diskteki PNG'lerden, olay döngüsünün her turunda bir kayıt — bazıları 16000 piksel yüksekliğinde ve otuzunu arka arkaya çözmek ana süreci saniyelerce kilitlerdi. Gerçek indeksin kopyası üzerinde ölçüldü: 30 kaydın 27'si hücreyi kaplar hâle geliyor, 5 saniye sürüyor, indeks 284KB'den 483KB'ye çıkıyor.
- Kare yüksekliği 92 → 108px. İkon sütunu dört 22px düğme + aralar + 4px üst boşlukla 98px yer istiyor; 92px'de **Sil** alt kenarda kesiliyordu.
- İlk kare sürekli seçili görünüyordu: karartma ve düğmeler `:hover`'ın yanı sıra `.selected` için de açılıyordu, ızgarada ise her zaman bir seçim var. İkisi de artık yalnız hover'da; seçim vurgu halkasıyla görünmeye devam ediyor.

---

# CopyBoard v2.10.0 Release Notes

Uygulamanın tamamının yeniden tasarımı; görüntüleyicide düzenleme ve zoom, koyu/açık tema, arayüz dili, atanabilir tüm kısayollar ve baştan düzenlenmiş Ayarlar paneli.

## 🎨 Arayüzün yeniden tasarımı
- **Tek tasarım sistemi:** `shared/tokens.css` renk (koyu + açık), tipografi, aralık, köşe, gölge ve hareket ölçeklerini tutuyor; dokuz pencerenin hepsi buna bağlı. Önceden `styles.css` `--accent`, `widget.css` ve `quickpaste.css` `--primary`, `viewer.css` üçüncü bir set, toast dördüncüsünü satır içinde tanımlıyordu — aynı mor beş yerde elle yazılıydı ve dördünde kaymıştı.
- **Webfont kaldırıldı:** Ana pencere her açılışta `fonts.googleapis.com`'dan Inter çekiyordu; diğer sekiz pencere zaten `system-ui`'ye düşmüştü, yani onu alan tek pencere diğerlerinden farklı görünen pencereydi. Sistem yığını 11–13px'te daha iyi hinting veriyor; o `<link>`'in taşıdığı satır içi `onload` işleyicisinin gitmesi, her pencerenin CSP'sinden `unsafe-inline`'ın düşmesini sağladı.
- **Kontrast ölçüldü:** Küçük metin iki temada da 4.5:1 üstünde. `--accent-text` var çünkü `--accent` koyu zeminde tam 4.5:1'de — dolgu için yeterli, metin için değil. `--danger-solid` var çünkü `--danger` üzerine beyaz 3.4:1 ölçüyor.
- **Görünüm modeli:** Hangi görünümün ekranda olduğunu artık kapsayıcıdaki `data-view` söylüyor. Önceden her görünümün görünürlüğü, başka bir görünümün sınıfının **yokluğu** üzerinden `:has()` ile ifade ediliyordu — "hangi görünümdeyim" sorusunun okunabilir tek bir cevabı yoktu.
- **İçerik türü sınıflandırma:** `shared/content-type.js` bir pano kaydının ne olduğunu belirliyor (link, e-posta, dosya, yol, kod, renk, çok satırlı, düz metin); satır listesi çizen üç pencere de bunu kullanıyor. Renk kodları CSSOM üzerinden gerçek rengiyle çiziliyor — CSP satır içi stil özniteliğini engelliyor, CSSOM'u engellemiyor.
- **Gün başlıkları ve göreli zaman:** Yapışkan `Bugün / Dün / Bu hafta / Daha eski` başlıkları; satır yalnızca başlığın söylemediğini yazıyor. `Intl.DateTimeFormat` örnekleri arayüz diline göre bir kez kuruluyor — önceden `tr-TR` sabit yazılıydı ve satır başına yeniden kuruluyordu.
- **Satır kuyruğu sabit genişlikte:** Zaman damgası hover'da yerini eylem düğmelerine bırakıyor, metin kaymıyor. Eski çözüm metnin üzerine kayan opak bir gradyan plakaydı.
- **Klavye katmanı:** `modules/keyboard.js`. Seçim yeniden çizimlerde **kayıt id'sinden** geri kuruluyor, yani pano güncellemesi imleci başa atmıyor. `aria-activedescendant` liste kutusunda, odak arama kutusunda kalıyor.
- **Yıkıcı işlemler için tek onay diyaloğu:** `confirmAction()` söz döndürüyor; geçmişi temizleme, favoriden klavyeyle çıkarma ve klavyeyle ekran görüntüsü silme aynı kapıdan geçiyor. Esc dahil her çıkış yolu sözü karara bağlıyor.
- **Uygulama içi renk seçici:** `<input type="color">` bu pencerede çalışamazdı — pencere odağını kaybedince kendini gizliyor, işletim sisteminin renk paneli ise tam olarak odağı alıyor. `modules/color-picker.js` hazır renkler, ton kaydırıcısı ve hex alanından oluşuyor.
- **Ayarlar kartları:** Bölümlerin açık/kapalı durumu `localStorage`'da; ilk açılışta hepsi kapalı. Ayar araması başlık ve açıklama metinlerinde eşleşiyor, eşleşen bölümü geçici olarak açıyor (kalıcı duruma yazmadan).
- **Yakalama katmanları için ortak krom:** `--overlay-*` grubu snipper, kayıt ve OCR'ın araç çubuklarını tek yüzeyde topluyor. Açık temada ayrıca `--overlay-shadow` var: soluk bir çubuğun soluk bir ekran görüntüsü üzerinde kendi kenarı olmadığı için saç teli halka + daha derin gölge.
- **Ekran üstü ipuçları:** `shared/overlay-tooltip.js`. Yerel `title` ipucu işletim sistemi tarafından normal pencere seviyesinde çiziliyor; bu katmanlar her şeyin üstünde durduğu için ipuçları arkalarında kalıyor ve hiç görünmüyordu.

## 🔎 Arama: Türkçe katlama
- `toLowerCase()` bu dili eşleştiremiyor ve hatalar istisna değil: `'İSTANBUL'.toLowerCase()` sonucu `'i̇stanbul'` — bir `i` ve ardından **U+0307 COMBINING DOT ABOVE**, dolayısıyla "istanbul" araması onu hiç bulmuyordu. `'IŞIK'` → `'işik'`, yani "isik" kaçırıyordu; "gunes" `Güneş`'i bulmuyordu.
- Sorgu ve içerik tek bir katlamadan geçiyor: küçült → `U+0307` at → `ı ş ğ ç ö ü` → `i s g c o u`. Eşleşme iki yönlü simetrik.
- Türkçe küçültme kuralları yerine ASCII'ye katlama bilinçli: `ı` tuşu olmayan bir klavyede "isik" yazan `ışık`ı bulmalı.
- NFD normalizasyonu yerine tek regex geçişi: liste her tuş vuruşunda yüz KB'larca kaydı yeniden süzüyor; bu, yerini aldığı `toLowerCase()` ile aynı maliyet sınıfında.

## 🐞 Bu sürümde düzelen davranışlar
- **Çizim kopyalandıktan sonra hayalet kalıyordu:** Kopyalama çizimi yeni bir galeri kaydına gömüyor ama kaynak resim kendi şekillerini tutmaya devam ediyordu — aynı çizim iki yerde. Kopyayı silip komşuya (orijinale) dönünce çizim geri basılıyor, yanlış resim silinmiş gibi görünüyordu. Şekiller dosyalandıkları anda bırakılıyor; artık var olmayan kayıtların çizimleri galeri listesi değiştiğinde temizleniyor.
- **Çizim modunda navigasyon:** `syncNav()` tek karar noktası — çizim araçları açıkken ok tuşları, ‹ › düğmeleri ve film şeridi kapalı.
- **Kayıt araç çubuğu açık temada okunmuyordu:** Çubuk sabit koyuyken etiket, hover ve alan renkleri `--fg-rgb` üzerinden gidiyordu; o değişken açık temada siyaha döndüğü için koyu çubuk üzerinde koyu gri yazı oluyordu.
- **Güncelleme kutusunun başlık ikonu:** Mor gradyan üzerinde `rgba(var(--fg-rgb), 0.2)` kullanıyordu, açık temada çamurlu koyu bir daireye dönüyordu.
- **Favorilerde çift eylem:** Satır hem yıldız hem çöp kutusu taşıyordu, ikisi de aynı çağrıya bağlıydı.
- **Snipper'ın gövdesinde yazı tipi tanımlı değildi** — bilgi şeridi dahil her dize varsayılan serif ile çiziliyordu.

## ⚡ Performans
- Sekme geçişindeki 150ms'lik yapay gecikme kaldırıldı; liste tek haneli milisaniyelerde yeniden çiziliyor.
- Arama 90ms geciktiriliyor: `maxItems` 500'e çıkabiliyor ve yazma hızında bu, kullanıcının sormayı bitirmediği bir sonuç için saniyede birkaç tam yeniden çizim demekti.
- Satırlar `DocumentFragment` ile bir kerede ekleniyor; satır metni ve ipucu metni DOM'a girmeden kırpılıyor (kopyalama ve arama her zaman tam içeriği kullanıyor).
- Widget satır yüksekliği 44px → 38px; sanal listenin aritmetiği `ITEM_HEIGHT` ile birlikte taşındı.

## 🖼️ Büyük görüntüleyicide düzenleme
- **Çiz:** Snipper'ın araç seti (kalem, kare, yuvarlak, ok, metin, bulanıklaştır) artık büyük görüntüleyicide de var. Kanvas görüntünün **kendi çözünürlüğünde** tutuluyor: pencere ne kadar küçük olursa olsun kopyalanan resim tam kalitede işaretleniyor. Çizimler piksel değil **vektör işlem listesi** olarak saklanıyor — geri alma bu yüzden ucuz, ve galeride ileri geri gezerken her resim kendi çizimini koruyor.
- **Çizilebilir alan çerçeveleniyor:** Araçlar açıkken resmin kenarına vurgu halkası ve köşe ayraçları geliyor, dışındaki letterbox koyulaşıyor. Kalemin nereye değdiği tahmine kalmıyor.
- **Alan Seç (kırp):** Seçim dışındaki her yer soluyor, seçimin boyutu yazıyor, **Alanı Kopyala** yalnız o bölgeyi alıyor — çizimler dahil, soldurma hariç.
- **Düzenlenmiş kopya galeriye de giriyor:** Panoya kopyalanıyor **ve** galeride kendi kaydı oluyor; görüntüleyici o yeni kayda geçiyor, yani ekranda gördüğünüz şey kopyaladığınız şey. (`addScreenshot()` artık oluşturduğu kaydın id'sini döndürüyor.)
- **Sil:** Ekrandaki görüntüyü siliyor; `removeShot()` açık görüntüleyiciyi komşu kayda geçiriyor, sonuncuysa pencereyi kapatıyor.
- **Başlık:** Boyutların yanında **dosya boyutu** da var. Bilgiler ayrı ayrı çipler hâlinde; pencere daraldıkça en az gereken bilgi ilk düşüyor.

## 🔍 Görüntüleyicide zoom
- **Trackpad'de pinch** veya **Ctrl/Cmd + tekerlek**. Düz tekerlek yakınlaştırılmış resmi kaydırıyor.
- Zoom **imlece sabitleniyor**: baktığınız nokta yerinde kalıyor, resim onun etrafında büyüyor.
- **Ctrl/Cmd +/−** adım adım, **Ctrl/Cmd+0** sığdır, **Ctrl/Cmd+1** gerçek boyut. Resme tıklamak sığdır ↔ %100 arasında geçiş yapıyor.
- Başlıkta tek parça bir kontrol: **− · %değer · +**. Yüzdeye tıklayınca %100, tekrar tıklayınca sığdır. Aralığın uçlarında ilgili düğme kendini kapatıyor. Ölçek **%10 – %800**.
- Sığdırma bir taban değil: altına inilebiliyor. Zoom yalnızca tam sığdırmanın üzerine denk geldiğinde oraya yapışıyor — aynı görüntüyü kaydırma çubuklarıyla gösteren ölü bir bölge kalmasın diye.
- Çizim kanvası zoom'dan etkilenmiyor: `layoutCanvas()` resmin çizilen kutusunu takip ediyor, o kutuyu kimin belirlediği fark etmiyor.

## ⌨️ Kısayollar: artık her tuş atanabiliyor
- Kayıt eden bileşen kendi modülüne taşındı ve artık **fiziksel tuşu** (`e.code`) saklıyor, basılan karakteri değil. Global kısayollar konuma göre eşleşir; `e.key` okumak, kaydı sorunsuz alınıp **hiç tetiklenmeyen** kısayollar üretiyordu: Türkçe-Q'da Cmd+Shift+2 `'` yazdığı için ABD klavyesindeki apostrof tuşuna bağlanıyordu.
- **Esc altındaki tuşun** (`kVK_ISO_Section` / `IntlBackslash`, Türkçe-Q'da `"`) Electron'da adı **yok**. Electron 39 `"IntlBackslash"`, `"OEM_102"` ve `"§"` değerlerini reddediyor; `"\""` ise ABD klavyesindeki tırnak konumuna, yani o düzendeki **i/İ tuşuna** çözülüyor — bağlanan kısayol sessizce yanlış tuşu dinliyordu. Yedi aday değer gerçek tuşa karşı denendi, hiçbiri ulaşmıyor.
- `native/mac-hotkey`: bu tuşları Carbon'un `RegisterEventHotKey` çağrısıyla **ham keycode** üzerinden bağlayan yerel eklenti — Electron'un kendi kullandığı OS mekanizmasının aynısı. **Tuş dinleyici değil**: kombinasyon basılana kadar hiçbir şey çalışmıyor, yazarken sıfır maliyet.
- Eklenti **isteğe bağlı**: Windows derlemeyi atlıyor, Xcode Command Line Tools olmayan makine hata değil uyarı alıyor; her iki durumda da uygulama Electron'a düşüyor ve tuş yalnızca "kullanılamaz" olarak raporlanıyor.
- `ipc/shortcuts.js` artık tek kapı: `claim()` / `release()` dışından kayıt yapılmıyor.

## 🌗 Koyu, Açık ve Sistem teması
- Üç mod: **Koyu · Açık · Sistem**. Sistem, açıkken canlı olarak OS'u takip ediyor. Varsayılan koyu kalıyor — güncelleme, kullanıcının CopyBoard ile ilişkilendirmediği bir OS ayarı yüzünden kendini yeniden boyamamalı.
- Tema değişimi **pencereleri yeniden yüklemiyor** (dilin aksine): `data-theme` anında değişiyor. Snipper kaplaması ve kayıt penceresi gibi altınızdan yeniden yüklenmesini istemeyeceğiniz yüzeyler için bu şart. Betik `<head>`'den yükleniyor, böylece ilk boyamadan önce doğru tema yerinde — gövdeden yüklense açık temaya giderken koyu bir parlama olurdu.
- Yaklaşım: yaklaşık **95 adet `rgba(255,255,255,α)`** kaplaması `--fg-rgb` üzerinden geçiyor (koyuda 255,255,255 / açıkta 0,0,0). Açık tema tek bir token bloğu; hiçbir kural hangi temada olduğunu bilmek zorunda değil.
- Kapsam: ana pencere, görüntüleyici, widget, hızlı yapıştır, kayıt penceresi, güncelleme kutusu, toast ve OCR paneli. Snipper koyu kalıyor — o bir pencere değil, ekranın üzerindeki bir karartma.
- `nativeTheme` de takip ediyor, yani kaydırma çubukları ve yerel denetimler uyumlu geliyor.

## 🌐 Arayüz dili (Türkçe / İngilizce)
- Türkçe **kaynak dil** olarak kalıyor ve her Türkçe metin kendi anahtarı: `t('Kaydet')` yerini aldığı düz metin gibi okunuyor, eksik çeviri ham bir tanımlayıcı değil **Türkçeye** düşüyor.
- Bu sayede işaretlemede `data-i18n` niteliği gerekmiyor: `shared/i18n.js` yüklenirken belgeyi bir kez dolaşıp sözlükte bulduğunu değiştiriyor. Bu dolaşma sayfa yalnızca kendi arayüzünü tutarken çalışıyor; **asla pano içeriğinin üzerinden geçmiyor** — metni "Kaydet" olan bir geçmiş satırı sessizce yeniden yazılırdı. Çalışma anında üretilen metinler `t()` üzerinden geçiyor.
- Sözlük **194 girdi**. Dokuz pencerenin işaretlemesindeki Türkçe metinler gözle değil **betikle** çıkarıldı; ilk taramada 44 eksik bulundu. Ardından JS içindeki 71 kullanıcıya görünen metin sarmalandı (konsol/hata ayıklama satırları bilerek dışarıda).
- Doğrulama canlı yapıldı: İngilizceye geçildiğinde ekranda kalan tek Türkçe kelime **"Türkçe"** — bir dilin kendi adı — ve kullanıcının kendi pano içeriği, ki o hiçbir zaman çevrilmemeli.
- Dil değiştirmek her pencereyi yeniden yüklüyor ve tepsiyi yeniden kuruyor: her yüzey metinlerini yüklenirken boyadığı için yeniden yükleme **zaten** güncellemenin kendisi.
- Varsayılan bilerek Türkçe, **OS diline bakılmıyor**: uygulama bugüne kadar yalnız Türkçeydi, sistem dilini takip etmek mevcut her kullanıcıyı güncellemede İngilizceye çevirirdi.

## ⚙️ Ayarlar paneli
- Beş katlanır grup, kullanım sıklığına göre: **Kayıt Ayarları · Video Ayarları · Yüzen Araç · Kısayollar · Diğer Ayarlar**.
- Hepsi her açılışta **kapalı** başlıyor: bu bir tercih değil, bir açılır bölüm — Ayarlar her seferinde aynı kısa listeyle açılmalı. Panel, ne kadar ayar yapılmış olursa olsun tek ekrana sığıyor (widget açıkken önce 12 satırdı).
- Yüzen Araç'ın **aç/kapa anahtarı başlık satırında kalıyor**: widget'ı açmak için önce grubu açmak gerekmiyor. Alt ayarları yalnız widget açıkken var olduğundan, kapalıyken grup boş değil **devre dışı**; açar açmaz kendiliğinden genişliyor.
- Bağlantı artık genel: bir grup = `.group-header` düğmesi + `aria-controls` ile gösterdiği gövde. Yeni grup eklemek JS gerektirmiyor.
- **Dil** satırı grupların dışında, en altta: grup başlıklarını okuyabilmek için önce gerekebilecek tek ayar o.
- **Güncellemeleri Kontrol Et** başlıktan Ayarlar'a taşındı, **Hakkında** ise kendi paneli olmaktan çıkıp Ayarlar'ın en altına indi. Başlık altı ikondan dörde indi.
- Başlıktaki yanan düğme artık elle değil `syncHeaderActive()` ile belirleniyor: geçmiş sekmesi — en çok vakit geçirilen görünüm — hiç yanmıyordu.

## 🔄 Güncelleme kontrolü her zaman cevap veriyor
- "Zaten en güncel sürümü kullanıyorsunuz." mesajı vardı ama yalnız `update-not-available` olayında. İki yol kullanıcıya **sessizlik** olarak ulaşıyordu ki bu ölü bir düğmeden ayırt edilemez: paketlenmemiş derleme (electron-updater hiçbir olay yaymadan geri dönüyor — geliştirme çalıştırmasında her tıklama böyle) ve `error` olayı gelmeyen bir reddedilme.
- `manualUpdateCheck` bir jeton gibi çalışıyor: bir tıklama = tam olarak bir mesaj. `update-available` da jetonu temizliyor — aksi hâlde **bir sonraki sessiz arka plan kontrolü** durup dururken "günceldesiniz" diyordu.

## 🧰 Yüzen araç (widget)
- **Düğme ipuçları görünüyor:** Widget normal pencere seviyesinin üstünde yüzdüğü için Chromium'un yerel ipucu **arkasında** kalıyordu; sadece ikonlu düğmelerin okunur bir etiketi yoktu. Artık `aria-label` + widget'ın kendi penceresi içinde yaşayan sayfa-içi ipucu.
- **Hızlı Yapıştır düğmesi menüden kaldırıldı.** Özellik duruyor: global kısayolu ve tepsi menüsü girişi yerinde. macOS Secure Event Input kısayolu yuttuğunda fareyle giriş yolu da tepsi menüsü.

## ♿ Kontrast ve renk düzeltmeleri
Bu turda renkler gözle değil **ölçülerek** denetlendi: her ögenin efektif zeminini atalarından besteleyip WCAG oranını hesaplayan, `:hover` durumunu CDP ile zorlayan bir denetleyici yazıldı. Gözden kaçmış olanlar:
- Widget menü ikonları **1.21:1** (açık panelde sabit beyaz), aktif sekmesi 2.31, Geçmişi Temizle düğmesi 3.46.
- Açık temada **favori yıldızı 1.1:1** — `--warning`, açık blokta yeniden tanımlanmayan tek anlam taşıyan token'dı; yıldız pratikte boştu.
- Widget satır düğmelerinin arkasındaki tabla sabit koyuydu: açık temada koyu ikonlar görünecek yer bulamıyordu.
- Odaklanan alanlar (widget araması, not alanı) odakta %30-40 siyaha iniyordu: açık temada koyu gri zemin üstünde siyaha yakın metin.
- Güncelleme kutusunun sürüm notları alanı (%25 siyah) ve Hızlı Yapıştır'ın kapat düğmesi (**1.5:1**).
- Görüntüleyicinin Sil/Kapat düğmeleri koyu metinle kırmızıya dönüyordu; navigasyon okları, kırpma çubuğu ve metin kutusu hiç temalanmayan koyu çipllerdi.
- Çiz'e basınca resmin arka planı simsiyah oluyordu (letterbox `#0a0a0b` sabitti); soluk bir ekran görüntüsü soluk sahnede kenarsız kalıyordu (açık temada saç teli çerçeve eklendi); "1 / 30" çipi açık mor üstünde açık mordu.
- Hover'da vurgu rengi artık **koyulaşıyor**, açılmıyor: 11px beyaz etiketler açılan morda ve hover kırmızısında 4.5:1'in altındaydı.
- **Koyu temada** seçili sekme ikonu 2.6:1'deydi — seçili hâl en az görünen hâldi.
- Sonuç: dört pencere, iki tema, durgun ve hover hâlleri ölçülerek temiz.

## 🐞 Düzeltmeler
- **Görüntüleyici tamamen ölmüştü:** Film şeridini kuran kodda yerel bir `const t = document.createElement('img')` vardı; `t()` sarmalama betiği alt satırı `t.alt = t('küçük resim')` hâline getirip bir `<img>`'yi fonksiyon gibi çağırdı — üstelik betiğin "t zaten kapsamda mı?" kontrolü de aynı bildirime takılıp yardımcıyı hiç eklemedi. `viewer.js` en üstteki ilk `t()` çağrısında hata verince ondan sonra kaydedilen **her dinleyici** kayboldu: kapatma yok, oklar yok, resim yok. Aynı biçim için tüm renderer dosyaları tarandı.
- **Zoom'da resim çerçevenin tepesine yapışıyordu:** Sığdırma modundan çıkarken sahne flex'ten `display: block`'a geçiyor, dikey ortalama tam da o anda kayboluyordu. Sahne artık flex kalıyor ve ortalamayı `margin: auto` yapıyor — taşma başlayınca bu marjlar sıfırlandığı için resmin sol üst köşesi kaydırmayla erişilebilir kalıyor; ortalama anahtar kelimeleri kullanılsaydı o köşe kaydırma alanının dışında kalırdı.
- **Snipper:** Geri alma ve resmi kopyalama yalnız Ctrl'e bağlıydı; macOS'ta refleks Cmd. İkisi de kabul ediliyor.
- Yüzde göstergesi bir ara sığdırma modunda **%124** yazıyordu: `object-fit: contain` resmi eleman kutusunun içinde harflendirdiği için kutuyu ölçmek resmi değil kutuyu bildiriyor. Gösterge artık ölçülen değil, istenen ölçekten türetiliyor.

## 🧪 Test ve araçlar
- Kısayol kaydının klavye düzeni durumları için birim testleri; `test:electron` her kayıt çıktısını **gerçek** `globalShortcut.register()` çağrısına veriyor.
- Kontrast denetleyicisi ve metin çıkarıcılar bu turda yazıldı; denetleyici hesaplanan renkleri metin olarak ayrıştırdığı (`color-mix` çıktısı `oklab()` gelince açık lavantayı siyah sanıyordu) ve odakta olmayan pencerede yarım kalmış geçişleri okuduğu için iki kez yanlış sonuç verdi — ikisi de düzeltildi. Odakta olmayan pencerede compositor tıklamadığı için bir renk **geldiği** değeri bildirir; bu, hover taramasını farkında olmadan hover **öncesi** renklerin taramasına çeviriyordu.

## 📦 Kurulum & Güncelleme
1. CopyBoard-Setup-2.10.0.exe dosyasını indirip kurun; veya
2. Açık uygulamada otomatik güncelleme bildirimiyle geçin.

---

# CopyBoard v2.9.5 Release Notes

OCR'ın hiç çalışmaması, Secure Input altında hızlı yapıştırma ve widget menüsü.

## 🔤 OCR artık çalışıyor (kritik)
- Her tarama `TypeError: Only absolute URLs are supported` ile düşüyordu; Windows ve macOS'ta aynı şekilde. Sebep: tesseract.js worker thread'inde hangi ortamda olduğunu `is-electron` ile soruyor, cevap `'node'` değil `'electron'` olduğu için `langPath`'i **URL sanıp** node-fetch'e veriyor ve node-fetch düz bir dosya yolunu reddediyor (`worker-script/index.js:134`). Pakette gelen `eng/tur.traineddata` yerindeydi — bozuk olan yükleme yoluydu.
- Dil verisi artık `langPath` yerine **`cachePath` + `cacheMethod: 'readOnly'`** ile okunuyor: kütüphanenin cache okuyucusu düz `fs.readFile`, yani network koduna hiç girilmiyor. `readOnly` aynı zamanda kurulum dizinine yazmasını — init hata verirse gönderdiğimiz veriyi **silmesini** — engelliyor. Etkisiz kalan `langPath`/`gzip` seçenekleri kaldırıldı.
- Paketli veri bulunamazsa CDN'e düşülüyor ve indirilen veri `userData`'ya cache'leniyor: bozuk bir kurulumda da tarama çalışır, indirme bir kez olur.
- `errorHandler` verilmediği için tesseract hatayı **kendi mesaj dinleyicisinde `throw` ediyordu** → main process'te yakalanmamış exception, yani kullanıcıya hata kutusu (`createWorker.js:247`). Artık normal bir reject.
- `createWorker()`, dil yüklemesi başarısız olduğunda promise'ini **hiç settle etmiyor** (iç reject'i yalnızca core-load adımı için işliyor): ilk hatadan sonra `ocrWorkerPromise` sonsuza kadar pending kalıyor ve OCR uygulama yeniden başlatılana kadar tamamen ölüyordu — ekranda tek iz "Metin Taranıyor..." toast'ıydı. Worker kurulumu (45 sn) ve taramanın kendisi (60 sn) artık zaman aşımlı.
- Worker thread'i ölürse `exit` olayında cache anında bırakılıyor. tesseract bunu göremiyor: thread'e async `send()` ile post ettiği için hata unhandled rejection olarak kayboluyor ve `recognize()` hiç settle etmiyor. Ölmüş worker'a denk gelen tarama artık sessizce yenisini kurup devam ediyor, kullanıcı hata görmüyor.
- Yeniden deneme yalnızca **düzelebilecek** durumda yapılıyor: önceki taramadan kalan worker. O tarama için yeni kurulmuş bir worker hata verdiyse sorun görüntüde ya da ortamda, yeniden kurmak sıcak worker'ı boşa harcamaktan başka bir şey yapmaz.
- Ölçüm (gerçek uygulama, uçtan uca sürülerek): overlay 180 ms'de açılıyor, soğuk worker'la tarama 713 ms, sıcak worker'la 442 ms.
- Yan not: `options` içinde hiç okunmayan `load_system_dawg`/`load_freq_dawg` kaldırıldı — bunlar `createWorker`'ın 4. (`config`) argümanına ait, verildikleri yerde etkisizdi.

## 📋 Hızlı Yapıştır widget'tan (macOS Secure Input)
- Widget menüsüne **Hızlı Yapıştır** düğmesi eklendi. Bir parola alanı odaktayken macOS **Secure Event Input**'u açar ve klavyeyi o uygulamaya kilitler: global kısayol hiç tetiklenmez. Fare olayları etkilenmediği için bu düğme, o durumda panele **tek giriş yolu**.
- Yapıştırma hedefi widget'a **fare girdiği anda** okunuyor (`note-front-app` → `noteFrontApp()`): tıklama CopyBoard'u öne alıyor, dolayısıyla hover kullanıcının gerçekten yazdığı uygulamayı görebildiğimiz son an. 1.5 sn throttle ve hover sırasında asla izin kutusu açılmıyor (tek prompt `warmPasteHelper()`'da kalıyor).
- Hatırlanan hedef 120 sn yaşıyor. Frontmost CopyBoard'un kendisi olduğunda hedef **silinmiyor** — silinse Cmd+V kendi penceremize giderdi — yalnızca eskimişse bırakılıyor.
- Windows'ta yapıştırma öndeki pencereye giden düz bir Ctrl+V olduğu için menüyü açan tıklamanın aldığı odak widget'tan bırakılıyor (`blur`) ve alttaki uygulamaya geri veriliyor. macOS'ta hedef yeniden aktive edildiğinden o yol olduğu gibi bırakıldı.
- Ayarlardaki Hızlı Yapıştır kısayolunun ipucu artık Secure Input durumunu ve widget/tepsi alternatifini anlatıyor.

## 📐 Widget menüsü
- Menü yüksekliği 350 → 402 px. Altıncı öğe (Hızlı Yapıştır) eklendikten sonra 70 px offset + 6 × 42 px öğe + 5 × 10 px boşluk sığmıyor, son düğme kırpılıyordu.

---

# CopyBoard v2.9.4 Release Notes

Satır düğmelerinin ipuçları ve not metnini kopyalama.

## 💬 Satır düğmelerinin ipuçları artık görünüyor
- v2.9.3 sayfa-içi ipucu sistemini getirdi ama **geçmiş satırlarının içindeki düğmeler kapsam dışı kaldı**: `initTooltips()` `.history-item` içindeki her şeyi atlar (satırlar kendi içerik önizlemesini yönetir), dolayısıyla yıldız, kopyala ve sil düğmelerindeki `title` yerel ipucuna düşüyor, "her zaman üstte" pencerenin arkasında çizilip hiç görünmüyordu.
- Bu üç düğme artık — not düğmesi gibi — sayfa-içi ipucunu kendisi sürüyor: kendi dikdörtgenine tutturuluyor, 250 ms sonra beliriyor, fare ayrılınca kayboluyor. Satırın 500 ms'lik içerik önizlemesi düğmeye girildiğinde iptal ediliyor, iki ipucu asla çakışmıyor.
- Dört düğmede tekrarlanan bağlama tek bir `labelAction()` yardımcısında toplandı; `title` artık hiçbirinde yok, `aria-label` değerlerinin hepsi korundu ve tek yerden veriliyor.

## 📋 Notu kopyala
- Not penceresine bir **kopyala düğmesi** eklendi: öğenin kendisini değil, **notun metnini** panoya alır ve geçmişe ekler.
- Yeni `copy-text` IPC'si satır kopyalamadan (`copy-item`) farklı olarak **pencereyi gizlemez** — düğmenin yerinde onay verebilmesi için. İkon 800 ms tik işaretine döner, sonra geri gelir.
- Düğme yalnızca not görüntüleme modunda görünür; düzenleme modunda gizlenir (henüz kaydedilmemiş metin kopyalanmasın diye).

---

# CopyBoard v2.9.3 Release Notes

Renk kodu alma, kısayol başına aç/kapa, görünür ipuçları ve galeri araç çubuğu.

## 🎨 Renk Kodu Al (yeni)
- Yeni kısayol (varsayılan **Alt+3**) ve tepsi menüsü öğesi: ekran donuyor, büyüteç imlecin altındaki pikselin hex kodunu canlı gösteriyor, tek tık kodu panoya + geçmişe alıyor (`Renk kodu kopyalandı: #336699`), **Esc** iptal ediyor.
- Bu modda ekran **karartılmıyor** — normal ekran görüntüsü modundaki %50 karartma, kopyalanandan başka bir renk görmene sebep olurdu. Seçim kutusu/araç çubuğu da gizli; büyüteç tek araç.
- Büyüteç etiketi ile tıklamanın kopyaladığı değer artık **aynı kaynaktan** (ekran görüntüsü katmanı) okunuyor; önceden etiket büyütülmüş kopyadan örneklendiği için ayrışabilirdi.

## 🎚️ Kısayol başına aç/kapa
- Ayarlar'da her kısayolun yanında bir anahtar var. Kapatınca kısayol işletim sisteminden **bırakılıyor**, yani o kombinasyon başka uygulamalara serbest kalıyor — CopyBoard'un bir tuşu gasp etmesi böylece çözülüyor.
- Kısayolun **değeri silinmiyor**: girdi soluklaşıyor ama bağlama duruyor, tekrar açınca aynı tuşla geri geliyor. Kapalıyken değiştirilirse yeni değer saklanıyor, açıldığı anda kaydediliyor.
- Kapalı bir kısayol tepsi menüsünde de gösterilmiyor ve menü açıkken tetiklemiyor; menü öğesinin kendisi tıklamayla çalışmaya devam ediyor. Tercih kalıcı.

## 💬 İpuçları artık görünüyor
- Ana pencere "her zaman üstte" olduğu için, macOS'un yerel `title` ipuçları (ayrı bir sistem penceresinde normal seviyede çizilir) **pencerenin arkasında kalıyor ve hiç görünmüyordu** — başlıktaki düğmeler, ayar satırları, hepsi.
- İpuçları artık sayfanın içinde çiziliyor: bir öğenin üzerine ilk gelindiğinde `title` otomatik olarak sayfa-içi ipucuna dönüştürülüyor (yerel olan kaldırılıyor, çift ipucu olmuyor). Sonradan oluşturulan satır/düğmeler de kapsanıyor; pencere kenarına yaklaşınca yukarı dönüyor.
- Geçmiş satırlarının 500 ms'lik ipucu da aynı elemanı kullanıyor — tek sistem, iki ipucu asla üst üste binmiyor.

## 🖼️ Galeri araç çubuğu
- Grid düğmelerinin karşısına, sola iki galeri-geneli işlem eklendi: **Klasörde Göster** (ekran görüntüsü klasörünü açar) ve **Büyük Görüntüle** (en yeni görüntüyü büyük pencerede açar). Galeri boşken ikisi de pasif.

## ✨ Görünüm
- Ayar panelindeki tüm onay kutuları **kayan anahtar** (switch) görünümüne geçti. Tamamen görsel: öğeler hâlâ gerçek checkbox olduğundan mevcut mantık, etiket tıklaması ve klavye erişimi değişmedi.

---

# CopyBoard v2.9.2 Release Notes

macOS menü çubuğu (tepsi) simgesi düzeltmeleri.

## 🍎 Tepsi simgesi artık pencereyi açıyor
- macOS'ta simgeye **sol tıklamak menüyü açıyordu**; `setContextMenu()` bağlandığında AppKit sol tıklamayı menüye ayırıyor ve koddaki `tray.on('click', showMain)` hiç çalışmıyordu. Artık **sol tık pencereyi açıp kapatıyor**, menü (Göster / Hızlı Yapıştır / Ekran Görüntüsü / OCR / Video / Çıkış) **sağ tıkta**. Windows/Linux davranışı değişmedi.
- Açık pencerede simgeye tıklayınca kapanıyor: pencere zaten `blur` ile gizlendiği için tıklama olayı geldiğinde kapanmış oluyordu ve saf bir "görünürse gizle" mantığı onu hemen yeniden açardı; yeni yeni gizlenmiş bir pencere artık "bu tıklama kapattı" sayılıyor.

## 🚫 "Göster" bazen hiçbir şey yapmıyordu
- Tepsiden gösterilen pencere, macOS odağı önceki uygulamaya geri verirken **anında `blur` alıp kendini tekrar gizleyebiliyordu** — tıklama boşa gitmiş gibi görünüyordu. Kasıtlı bir gösterimden hemen sonraki blur artık yok sayılıyor (600 ms), ayrıca dock gizli (accessory) uygulama olduğu için macOS'ta `app.focus({steal:true})` ile uygulama gerçekten öne alınıyor.

## ⌨️ Menü açıkken basılan kısayollar birikip topluca patlamıyor
- macOS'ta yerel menü **modal bir olay döngüsü** çalıştırır: menü açıkken ana süreç `globalShortcut` geri çağrılarını işlemez, basılan her kısayol **kuyruğa girer** ve menü kapanınca hepsi birden tetiklenirdi (arka arkaya ekran görüntüsü/OCR/kayıt). Menü açılırken kısayol kayıtları bırakılıyor, kapanınca geri alınıyor: basış artık gerçekten yok sayılıyor. Kapanış olayı hiç gelmezse 60 sn'lik emniyet zamanlayıcısı kayıtları geri yükler.

---

# CopyBoard v2.9.1 Release Notes

macOS'ta ilk ekran görüntüsü artık siyah yapışmıyor; genel performans iyileştirmeleri.

## 📸 İlk çekimde siyah görüntü düzeltildi (macOS)
- Uygulama açıldıktan sonraki **ilk** ekran görüntüsü, panoya yapıştırıldığında **siyah bir dikdörtgen** (üzerinde yalnızca ok/çizimler) çıkabiliyordu; ikinci çekim her zaman düzgündü. Sebep: macOS'ta oturumun ilk `desktopCapturer.getSources()` çağrısı, ScreenCaptureKit henüz ısınmadığı için **boş bir kare** döndürebiliyor (0 baytlık PNG). Bu boş veri ekran katmanına hiç çizilemiyordu; overlay penceresi saydam olduğu için altındaki canlı masaüstü görünüyor ve her şey normal sanılıyordu — ta ki kopya yapıştırılana kadar.
- Çözüm kendi kendini iyileştirme üzerine kurulu, kullanıcıya soru sorulmuyor:
  - Ana süreç boş kareyi fark edip çekimi kısa aralıklarla kendisi yineliyor (ekran başına 5 deneme).
  - Yine de kullanılamaz görüntü ulaşırsa (boş/bozuk PNG), overlay yeni `capture-retry` kanalıyla **sessizce yeni bir yakalama istiyor**; pencere ancak kullanılabilir görüntüyle görünür olduğundan bu denemeler tamamen görünmez.
  - Tüm denemeler tükenirse (ör. Ekran Kaydı izni geri alınmışsa) engelleyici pencere yerine kısa bir bildirim gösterilip overlay kapatılıyor; uygulama askıda kalmıyor.
- Kopyalama son bir güvenlik denetiminden geçiyor: tamamen saydam (yapıştırıldığında siyah görünecek) bir kırpma artık panoya hiç gönderilmiyor.

## 🖼️ Görüntünün sessizce silinmesi engellendi (Snipper, OCR, Kayıt)
- Yakalama yüklendikten sonra gelen bir pencere `resize` olayı, canvas boyutu yeniden atandığı için **ekran görüntüsünü, çizimleri ve geri-al geçmişini sessizce siliyordu** — saydam pencere yüzünden yine fark edilmiyordu. Görüntü artık bellekte tutuluyor; boyut değişiminde silinmek yerine yeniden çiziliyor. Aynı düzeltme OCR ve ekran kaydı bölge seçimine de uygulandı.

## ⚡ Genel Performans
- **Geçmiş yazmaları artık toplu:** her pano kopyalaması, tüm ayar dosyasını (~1MB'a ulaşabiliyor) ana süreçte senkron olarak baştan yazdırıyordu. Yazmalar yarım saniyelik pencerede birleştiriliyor; çıkışta ve uyku/kilitte anında diske işleniyor. Saklanan veri değişmiyor.
- **Yayınlar yalnızca görünür pencerelere:** her kopyalamada ~0,5MB'lık geçmiş, gizli olsalar bile 3 pencereye IPC ile gönderiliyordu. Artık yalnızca görünür pencereler push alıyor; gizli pencereler açılırken güncel veriyi kendileri çekiyor (veri kaybı yok).
- **Aşırı büyük kopyalar (1MB+ metin) geçmişe alınmıyor:** ya bütün olarak saklanır ya hiç — kesilerek saklama yok (kesik öğe daha sonra panoya eksik yapışırdı). Pano işleyişi etkilenmez; bu sınır ayar dosyasının kontrolsüz büyüyüp açılışı yavaşlatmasını önler.
- **Liste satırları tek satır:** geçmiş/favori satırları artık tek satırda üç nokta ile kısaltılıyor (tarih aynı satırın sağında); öğenin geniş hali imleç satırın üzerinde **500 ms** durunca çıkan araç ipucunda gösteriliyor. İpucu içeriği yalnızca o anda kuruluyor — satır başına DOM metni ~%85 azaldı, çok satırlı sarma hesabı kalktı (ana pencere + widget + hızlı yapıştır). Kopyalama ve arama her zaman bellekteki tam içerikle çalışır.
- **Toast bildirimleri tek pencereyi yeniden kullanıyor:** her bildirim yeni bir renderer süreci başlatıyordu (~100-300ms). Pencere bir kez kurulup gizlenerek yeniden kullanılıyor (v2.9.0'daki imleç-ekranı konumlandırması ve tam ekran üstü görünürlük korunuyor).
- **OCR belleği boşta serbest bırakılıyor:** Tesseract işçisi ilk taramadan sonra süresiz bellekte kalıyordu (150MB+). 5 dakika kullanılmayınca kapatılıyor; sonraki tarama yalnızca 1-2 sn ısınma bedeli öder (v2.9.0'ın çevrimdışı dil paketi sayesinde indirme gerektirmez).
- **Widget "üstte tut" zamanlayıcısı seyreltildi** (3sn → 10sn): gösterimde ve her konum değişiminde zaten yeniden uygulanıyor; sık aralık boşuna uyandırıyordu.

## 🧭 Arayüz
- **Bildirim (toast) yüksekliği içeriğe göre ayarlanıyor:** pencere sabit 320×100 olduğu için uzun mesajların sonu kırpılıyor ve okunamıyordu (ör. Erişilebilirlik izni uyarısı 138 px gerektiriyordu, 38 px'i görünmüyordu). Kart artık ölçülüp pencere ona göre büyütülüyor/küçültülüyor; kart pencere dışında beklediği için boyutlanma görünmez, sağ-üst köşe sabit kalıyor.
- **"+" (Manuel Ekle) düğmesi kaldırıldı** — artık gerekmiyordu; düğme, modal, DOM referansları, preload köprüsü (`addManualItem`) ve ana süreçteki `add-manual-item` IPC handler'ı dahil tüm zincir söküldü. Yerine başlıkta **Geçmiş** düğmesi var: galeri/ayarlar/hakkında panellerinden tek tıkla geçmiş listesine (Tümü sekmesi) dönülüyor — galeri düğmesinin simetriği.
- **Widget geçmiş paneli ana pencereyle tutarlı:** satırlar aynı tasarımda — tek satır metin + sağda tarih-saat, aynı yazı boyutu/rengi, aynı 500 ms araç ipucu. Sanal kaydırma satır yüksekliği yeni kompakt düzene göre güncellendi (56→44 px).

## 🖥️ Windows
- Boş ilk kare macOS'a özgü bir durum; Windows'ta davranış pratikte değişmedi (aynı korumalar orada da devrede ama tetiklenmeleri beklenmez). Performans iyileştirmeleri iki platformda da geçerli.

---

# CopyBoard v2.9.0 Release Notes

Galeri yenilendi: büyük görüntüleyici penceresi geldi; macOS düzeltmeleri, çevrimdışı OCR ve video kaydı iyileştirmeleri.

## 🖼️ Büyük Görüntüleyici (yeni)
- Ekran görüntüleri artık ekrana göre boyutlanan, yeniden boyutlandırılabilir ayrı bir pencerede açılıyor: **←/→** ile gezinme, fareyle beliren yan oklar, altta tıklanabilir **filmstrip** (aktif kare vurgulu), başlıkta boyut • tarih • "3 / 25" konumu.
- Pencereden büyük görsellerde tıkla → gerçek boyut (kaydırılabilir), tekrar tıkla → sığdır. Araç çubuğunda Kopyala / Klasörde Göster; **Esc** kapatır.

## 🖼️ Galeri
- Küçük panel-içi önizleme kaldırıldı; her işlem ızgarada: kareye **tıkla → kopyala** (geçmiş satırlarıyla aynı jest, yeşil çerçeve + toast geri bildirimi).
- Her karenin köşesinde dikey işlem sütunu: **Büyüt / Kopyala / Klasörde Göster / Sil**; sağ tık menüsüne **Büyük Görüntüle** eklendi.
- Görünüm değiştirici: **tek sütun** (büyük kareler) / **iki sütun**; tercih kalıcı.

## 🍎 macOS
- Kısayolla açılan ana pencere artık bulunduğunuz masaüstünde (Space) açılıyor; macOS sizi pencerenin eski masaüstüne ışınlamıyor.
- Parola yöneticilerinin gizli işaretlediği pano içerikleri (nspasteboard Concealed/Transient) Mac'te de geçmişe alınmıyor (Windows'taki korumanın eşleniği).
- Tepsi ikonu Retina ekranlarda artık net (trayIcon@2x paketleniyor).
- Toast bildirimleri imlecin olduğu ekranda çıkıyor ve tam ekran (fullscreen Space) uygulamaların üzerinde de görünüyor.

## 🔤 OCR
- eng/tur dil dosyaları uygulamayla paketleniyor (extraResources → tessdata): ilk taramada ~10MB CDN indirmesi yok, OCR çevrimdışı da çalışıyor.

## 🎬 Video Kaydı
- Chunk yazımı dosyayı her seferinde açıp kapatan senkron yazımdan tek WriteStream'e taşındı; kaydetme diyalogları asenkron — diyalog açıkken uygulama (pano izleyici dahil) donmuyor.
- Son video parçasının diske record-stop'tan önce ulaşması garanti edildi (uzun kayıtlarda son saniyenin kırpılabildiği yarış giderildi).

## ⌨️ Kısayol Ayarları
- Ok tuşları, noktalama ve numpad tuşları doğru Electron adlarıyla kaydediliyor (ör. Alt+↑); desteklenmeyen tuşlar net mesajla reddediliyor.
- Modifiersız tek tuş bağlanamıyor (yalnız "A" tuşu tüm sistemde A harfini gasp ederdi; F-tuşları istisna).

---

# CopyBoard v2.8.7 Release Notes

macOS'ta Hızlı Yapıştır artık gerçekten yapıştırıyor.

## ⚡ Hızlı Yapıştır (macOS)
- Hızlı Yapıştır'dan bir öğe seçildiğinde macOS'ta yapıştırma hiç gerçekleşmiyordu: panel açılıyor, öğe panoya kopyalanıyor, ama odaktaki metin alanına bir şey yazılmıyordu. Sebebi, tuş vuruşu gönderen kodun yalnızca Windows için yazılmış olmasıydı (`sendPasteKeystroke` macOS'ta hiçbir şey yapmadan dönüyordu). Artık macOS'ta da `Cmd+V` gönderiliyor.
- Panel açılırken o an önde olan uygulama hatırlanıyor ve yapıştırmadan hemen önce tekrar öne alınıyor; panele tıklamanın odağı kaydırdığı durumlarda seçilen öğe yanlış yere gitmiyor.
- Erişilebilirlik (Accessibility) izni yoksa sistem izin penceresi uygulama tarafından açılıyor — kullanıcının Ayarlar içinde ilgili paneli elle bulması gerekmiyor. İstem oturum başına yalnızca bir kez gösteriliyor.
- İzin verilmemişse veya yapıştırma başarısız olursa artık sessiz kalınmıyor: eksik iznin türünü (Erişilebilirlik / Otomasyon) belirten bir uyarı gösteriliyor ve öğenin panoya kopyalandığı, `Cmd+V` ile elle yapıştırılabileceği bildiriliyor.
- Bilinen davranış: macOS verilen Erişilebilirlik iznini zaten çalışan bir uygulamaya uygulamaz; izni verdikten sonra CopyBoard'un bir kez yeniden başlatılması gerekir.

## 🔏 macOS Kod İmzası
- macOS uygulaması şimdiye kadar hiç yeniden imzalanmıyordu: `identity: null` olduğu için electron-builder imzalamayı tamamen atlıyor ve paket, stok Electron ikilisinin ad-hoc imzasını taşıyordu. Sonuç olarak uygulamanın kod kimliği `Identifier=Electron` görünüyor, CDHash'i makinedeki diğer imzasız Electron uygulamalarıyla aynı oluyor ve uygulama kodu (`app.asar`) imza kapsamına hiç girmiyordu.
- Build'e `afterPack` adımı eklendi (`scripts/mac-adhoc-sign.js`): paket, gerçek bundle kimliğiyle ad-hoc yeniden imzalanıyor (`Identifier=com.nurullahyayan.copyboard`, helper'lar kendi alt kimlikleriyle). Bu, macOS izinlerinin (Erişilebilirlik/Otomasyon) doğru uygulamaya bağlanması için gerekli; sertifika ya da Apple hesabı gerektirmiyor.
- **Bu sürüme geçen macOS kullanıcıları Erişilebilirlik iznini bir kez yeniden vermek zorunda:** uygulamanın kod kimliği değiştiği için macOS eski izni tanımaz. Ayarlar → Gizlilik ve Güvenlik → Erişilebilirlik listesinde eski "CopyBoard" satırı varsa `−` ile kaldırın; yeni izin ilk Hızlı Yapıştır kullanımında istenecektir.
- Bu bir Developer ID imzası **değildir**. Ad-hoc imzada takım kimliği bulunmadığı için Gatekeeper uygulamayı hâlâ "doğrulanmamış geliştirici" sayar ve kod her değiştiğinde CDHash değişeceğinden izinler her sürümde yeniden istenir. Kalıcı çözüm Developer ID + notarization.

## 🖥️ Windows
- Bu sürümde Windows tarafındaki yapıştırma davranışı ve imzalama akışı değişmedi.

---

# CopyBoard v2.8.6 Release Notes

Ekran kaydına ses ekleme.

## 🎬 Ekran Kaydında Ses (yeni)
- Kayıt araç çubuğuna **🎤 Mikrofon** ve **🔊 Sistem Sesi (bilgisayar sesi)** aç/kapa düğmeleri eklendi; ikisi birlikte açıldığında tek ses kanalında mikslenir.
- Kapalı kaynağın ikonunda çapraz çizgi gösterilir (susturulmuş göstergesi); seçim sonraki kayıtlar için hatırlanır.
- Windows'ta mikrofon ve sistem sesi doğrudan çalışır. macOS'ta mikrofon desteklenir; sistem sesi işletim sisteminin desteklediği sürümlerde kaydedilir, aksi halde sanal ses aygıtı (ör. BlackHole) öneren bir uyarı gösterilir.
- Bir ses kaynağı alınamazsa kayıt sessizce iptal olmaz: uyarı verilir ve video (+ alınabilen ses) ile devam eder.

---

# CopyBoard v2.8.5 Release Notes

Kısayol ve Hızlı Yapıştır düzeltmeleri.

## ⚡ Hızlı Yapıştır
- Hızlı Yapıştır kısayolu (Ctrl+Shift+V) başka bir uygulamaca kullanılıyorsa kayıt sessizce başarısız oluyor ve pencere hiç açılmıyordu; artık başlangıçta her kısayolun kayıt sonucu denetleniyor ve paste kısayolu kaydedilemezse açıklayıcı bir uyarı gösteriliyor.
- Tepsi (tray) menüsüne **"Hızlı Yapıştır"** eklendi — kısayol hangi sebeple olursa olsun (çakışma, RDP/uç nokta politikası, rezerve kombinasyon) çalışmasa bile pencere her zaman buradan açılabilir.

## ⌨️ Kısayollar
- Cmd/Ctrl + {C, V, X, A, Z} gibi sistem Kopyala/Kes/Yapıştır tuşları genel kısayol olarak çalışamaz (öndeki uygulama yakalar ya da sistem kopyalaması bozulur); bu kombinasyonlar artık reddediliyor ve kullanıcı Alt/Shift eklemeye yönlendiriliyor — özellikle macOS'ta ekran görüntüsü için Cmd+C denemesini giderir.
- Daha önce kaydedilmiş geçersiz (rezerve) bir kısayol açılışta varsayılana döndürülür; böylece hem kısayol hem de Ayarlar ekranı düzelir.
- Başlangıç kaydı artık her kısayol için ayrı ayrı yapılıyor; biri başarısız olsa bile diğerleri etkilenmiyor.

---

# CopyBoard v2.8.4 Release Notes

Ekran Görüntüsü Galerisi için düzeltmeler.

## 🖼️ Galeri
- Küçük resme **sağ tık** → Kopyala / Klasörde Göster / Sil menüsü.
- Dosyası dışarıdan silinen ekran görüntüsünün ölü/tıklanmayan kaydı artık galeriden otomatik temizlenir (açılışta ve tıklama/kopyalama denemesinde).

---

# CopyBoard v2.8.3 Release Notes

Ekran görüntüsü aracı büyük güncelleme aldı: galeri, büyüteç/renk seçici, hassas seçim ve hız iyileştirmeleri.

## 🖼️ Ekran Görüntüsü Galerisi (yeni)
- Kopyalanan/kaydedilen ekran görüntüleri otomatik saklanır (son 30); ana penceredeki galeri butonundan küçük resim ızgarası, büyük önizleme, kopyala/klasörde göster/sil.

## 🔍 Büyüteç ve Renk Seçici (yeni)
- Seçim sırasında piksel büyüteci: koordinat + renk kodu; **C** tuşu renk kodunu panoya kopyalar (geçmişe de düşer).

## 🎯 Hassas Seçim
- **Enter** = kopyala; ok tuşları = 1px taşı, Shift+ok = boyutlandır, Ctrl = 10px adım.

## ⚡ Performans
- Yakalama ile overlay hazırlığı paralel (kararma daha hızlı); ekran görüntüsü aktarımı binary (base64 kalktı); blur aracı downscale tekniğiyle çok daha hızlı; undo geçmişi bayt bütçeli (4K+ bellek dostu).

---

# CopyBoard v2.8.2 Release Notes

Çoklu monitörde ekran yakalama artık "en son seçim kazanır" mantığıyla çalışıyor (bir ekranda seçip başka ekrana geçince önceki iptal olur), ekranlar daha hızlı kararıyor; yüzen widget ikonunun hover/leave'de kayması giderildi.

## 🖥️ Ekran Yakalama (Çoklu Monitör)
- Bir monitörde alan seçip başka monitörde seçim başlatınca önceki iptal olur; sadece en son seçilen alan kalır. Diğer ekranlar tam karanlık ve seçilebilir kalır.
- Ekranların kararması hızlandırıldı (sınırlı eşzamanlı yakalama; bellek sıçraması yok).

## 🎯 Widget
- Ana ikonun hover/leave sırasında 1-2px kayması düzeltildi.

---

# CopyBoard v2.8.1 Release Notes

Hızlı Yapıştır kısayolu **Ctrl + Shift + V** olarak değiştirildi (önceki: Alt + X). Ayarlar → Hızlı Yapıştır'dan özelleştirilebilir.

---

# CopyBoard v2.8.0 Release Notes

Öne çıkan yenilik **Hızlı Yapıştır** (Alt+X): panodan seçip odaktaki metin kutusuna anında yapıştırma. Ayrıca yüzen widget'ta kenar ve tıklama iyileştirmeleri.

## ✨ Yeni Özellikler
### 📋 Hızlı Yapıştır (Alt+X)
- Bir metin kutusundayken **Alt+X** ile imlecin yanında son pano öğeleri açılır; tıkladığınız öğe doğrudan o kutuya yapışır (pencere odağı kaybolmaz).
- Gösterilecek öğe sayısı **Ayarlar**'dan ayarlanabilir (varsayılan 20).
- `Esc` / ✕ / tekrar `Alt+X` ile kapanır. Kısayol Ayarlar'dan değiştirilebilir.

## 🎨 Widget İyileştirmeleri
- Widget kenarlarındaki gölge artığı giderildi (tam düz görünüm).
- Butonun hemen dışına yapılan tıklamalar artık arkadaki uygulamaya geçiyor (görünmez "ölü bölge" kaldırıldı).

---

# CopyBoard v2.7.0 Release Notes

Bu sürümün en büyük yeniliği **çoklu monitör desteği**: artık Ekran Görüntüsü, Metin Tara (OCR) ve Video Kaydı araçlarını istediğiniz monitörde kullanabilirsiniz. Ayrıca arayüz sadeleştirildi ve birçok kullanım kolaylığı ile kararlılık iyileştirmesi eklendi.

## ✨ Yeni Özellikler

### 🖥️ Çoklu Monitör Desteği
Önceden ekran araçları yalnızca farenin bulunduğu ekranda açılıyordu. Artık kısayola bastığınızda **tüm ekranlarınız aynı anda kararır** ve dilediğiniz monitörde alanı seçebilirsiniz. Bu; **Ekran Görüntüsü**, **Metin Tara (OCR)** ve **Video Kaydı** araçlarının hepsi için geçerli.
- Video kaydında alanı hangi monitörde çizerseniz o monitör kaydedilir.

### 🔄 Otomatik Güncelleme Kontrolü
Uygulama açılışında güncellemeleri **otomatik kontrol ediyor**; yeni bir sürüm varsa sizi bilgilendiriyor.

## 🎨 Görünüm ve Kullanım İyileştirmeleri
- **Sadeleşen Widget:** Yüzen araç daha modern, düz (flat) bir görünüme kavuştu; eski parlak/bombeli görünüm kaldırıldı.
- **Daha Düzenli Ayarlar Ekranı:** Ayarları açtığınızda yalnızca ayarlar görünüyor (pano geçmişi arkada görünmüyor), uzun liste rahatça kaydırılıyor ve **"Geçmişi Temizle"** butonuna her zaman ulaşabiliyorsunuz.
- **Küçük Kolaylıklar:** "Yeni Öğe Ekle" penceresinde **Ctrl+Enter** ile ekleyebilir, **Esc** ile yalnızca o pencereyi kapatabilirsiniz.

## 🎥 Video Kaydı
- **Temiz Kayıt:** Kayıt sırasında ekranda gördüğünüz seçim çerçevesi artık **videoya yansımıyor** — kayıtlarınız tertemiz çıkıyor.

## 🐛 Düzeltmeler ve Kararlılık
- **Daha İyi Bilgilendirme:** OCR bir metin bulamadığında veya bir işlem başarısız olduğunda artık kısa bir mesajla bilgilendiriliyorsunuz (önceden sessiz kalabiliyordu).
- **Kısayol Uyarısı:** Atadığınız bir kısayol başka bir uygulama tarafından kullanılıyorsa uyarı alıyorsunuz ve önceki çalışan kısayolunuz korunuyor.
- **Favoriler:** Arama yaparken favorileri sürükleyip sıralarken oluşan sıralama hatası giderildi.
- **Notlar:** Aynı metni tekrar kopyaladığınızda favori notunuz kaybolmuyor.
- **Ekran Alıntısı:** Metin (yazı) aracını kullanırken Ctrl+Z / Ctrl+C / Esc tuşlarının yanlış davranması düzeltildi.
- **Görüntü Kaydetme:** Ekran görüntüsü kaydedilirken bir sorun olursa artık uygulama çökme ekranı yerine dostça bir uyarı gösteriliyor.
- **Güvenlik ve Altyapı:** Güncelleme penceresi ve arka plan bileşenlerinde güvenlik ve kararlılık iyileştirmeleri yapıldı.
