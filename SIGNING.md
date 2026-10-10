# İmzalama

CopyBoard'da **iki ayrı imza** var ve karıştırılmamalı.

| | Ne için | Zorunlu mu |
|---|---|---|
| **Tauri güncelleyici imzası** | Güncellemenin bizden geldiğini doğrular | Güncelleme özelliği için **evet** |
| **macOS kod imzası** ("CopyBoard Dev") | İzinlerin (Ekran Kaydı, Erişilebilirlik) güncellemeler arasında korunması | Uygulama içi güncelleme için **evet** — CI onsuz yayın yapmıyor |
| **Apple Developer ID / Authenticode** | Gatekeeper / SmartScreen uyarısını kaldırır | Hayır — şu an yok |

---

## 1. Tauri güncelleyici imzası

Tauri'nin güncelleyicisi **imzasız güncelleme kabul etmez** ve bu kapatılamaz.
Apple/Microsoft ile hiçbir ilgisi yoktur; Tauri'nin kendi (minisign) anahtar çiftidir.

**Durum:** anahtar 10 Ekim 2026'da üretildi, **parolasız** (anahtar kimliği
`8898C4028D4D12B6`):

* **Özel anahtar** `~/.tauri/copyboard.key` — **ASLA depoya girmez.** Kaybolursa
  kurulu uygulamalar bir sonraki sürümü doğrulayamaz; yedeği güvenli bir yerde
  (parola yöneticisi) tutulmalı.
* **Genel anahtar** `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`
  (dosyası `~/.tauri/copyboard.key.pub`).

Anahtar tek yönlü bir karar: `pubkey` bir kez yayınlanmış sürüme girdi. Yeniden
üretmek (`npx tauri signer generate`) kurulu her uygulamanın otomatik güncellemesini
kalıcı olarak kırar — **yeniden üretme.**

### GitHub secret'ı

| Secret | Değer |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/copyboard.key` dosyasının İÇERİĞİ |

İçeriği ekrana basmadan panoya almak için:

```bash
pbcopy < ~/.tauri/copyboard.key
```

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` **tanımlanmıyor**: anahtar parolasız ve iş akışı
değişkeni boş dize olarak geçiyor (değişken hiç yoksa CLI terminalsiz ortamda parola
sormaya kalkıp düşüyor — NTerminal'de ölçüldü).

### `createUpdaterArtifacts` neden CI'da açılıyor

`tauri.conf.json`'da `bundle.createUpdaterArtifacts: false`; CI paketlerken
`--config '{"bundle":{"createUpdaterArtifacts":true}}'` ile açıyor. Bayrak açıkken
`tauri build` güncelleme paketini (`.app.tar.gz`, `-setup.exe`) imzalamak ister:
yapılandırmada açık olsaydı anahtarı olmayan her yerel `npm run build`
`A public key has been found, but no private key.` hatasıyla biterdi.

Yerelde güncelleme paketi üretmek gerekirse (ör. uçtan uca test) anahtarın **yolu**
verilebilir — CLI yol ya da içerik kabul ediyor, yol vermek içeriği süreç ortamına
koymuyor:

```bash
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/copyboard.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

`pubkey` boşsa uygulama güncelleyiciyi "yapılandırılmamış" sayar: açılış kontrolü
atlanır, elle kontrol anlaşılır bir uyarı toast'ı verir. `plugins.updater` bölümünü
tamamen silmek ise uygulamayı açılışta düşürür (BULGU F5-a) — bölümü silme.

---

## 2. macOS kod imzası

Dağıtılan paket **"CopyBoard Dev"** ile imzalanıyor: aşağıda yerel geliştirme için
oluşturulan kendinden imzalı sertifikanın AYNISI. CI onu `COPYBOARD_SIGNING_P12`
secret'ından geçici bir anahtarlığa alıyor. Apple Developer ID değil ve notarize
edilmiyor. Sonuçları:

* **İlk elle kurulumda** Gatekeeper uyarısı çıkar (sağ tık → Aç). Uygulama içi
  güncellemede çıkmaz: paketi uygulama kendisi indiriyor, karantina işareti konmuyor.
* **İzinler güncellemeler arasında korunur.** Belirlenmiş gereksinim
  `identifier "com.nurullahyayan.copyboard.tauri" and certificate leaf = H"998278a1…"`
  ve sertifika değişmedikçe sürümden sürüme aynı kalıyor. Sertifika **1 Eylül 2036**'ya
  kadar geçerli; yenilenen bir sertifikanın parmak izi farklı olur ve herkesin izni
  bir kez sıfırlanır.
* **CI bu imza olmadan yayın yapmıyor:** güncelleme anahtarı varken sertifika yoksa iş
  duruyor — ad-hoc imzalı bir güncelleme, güncelleyen herkesin iznini sessizce
  sıfırlardı. Paketlemeden sonra imzanın gerçekten CopyBoard Dev ile atıldığı ve
  gereksinimin sertifikaya bağlı olduğu da ölçülüyor.

### Sertifikayı CI'a vermek (bir kez)

1. *Keychain Access* → **login** anahtarlığı → **My Certificates** → "CopyBoard Dev"
   (açınca altında özel anahtarı görünmeli) → sağ tık → **Export "CopyBoard Dev"…** →
   biçim **Personal Information Exchange (.p12)** → güçlü bir parola ver.
2. GitHub → *Settings → Secrets and variables → Actions → New repository secret*:

   | Secret | Değer |
   |---|---|
   | `COPYBOARD_SIGNING_P12` | `base64 -i CopyBoardDev.p12 \| pbcopy` ile panoya alınan metin |
   | `COPYBOARD_SIGNING_P12_PASSWORD` | 1. adımdaki parola |

3. `.p12` dosyasını sil ya da güvenli bir yere taşı.

Sertifikaya geçici anahtarlıkta güven ayarı verilmiyor; gerek de yok — `codesign`
güvenilmeyen bir kimlikle de imzalıyor (ölçüldü). Tauri'nin `APPLE_CERTIFICATE`
yolu kullanılmıyor: yerelde kanıtlanmış yol, kimliğin anahtarlık listesinde olması
ve adının `APPLE_SIGNING_IDENTITY` ile verilmesi.

Apple Developer sertifikası ($99/yıl) alınırsa:

```json
"bundle": { "macOS": { "signingIdentity": "Developer ID Application: ...", "providerShortName": "..." } }
```

ve notarization eklenir; Gatekeeper uyarısı da kalkar. Kimlik değiştiği için
herkesin izni bir kez sıfırlanır.

### Geliştirme sırasında: izinler neden her derlemede sıfırlanıyor

macOS izinleri (TCC — Ekran Kaydı, Erişilebilirlik) uygulamayı **kod imzasının
"belirlenmiş gereksinimi"** ile tanır. İmzasız derlemede bağlayıcı ad-hoc bir imza
basar ve o imzanın gereksinimi binary'nin içerik hash'idir:

```
$ codesign -d -r- src-tauri/target/release/bundle/macos/CopyBoard.app
designated => cdhash H"029b55677ea8c42fc58633eb1f2e75048b2eec9b"
```

Her derleme farklı bir hash, yani macOS'a göre **her `npm run build` yeni bir
uygulama** — eski izin ona ait değil, Ayarlar'dan yeniden verilmesi gerekir.

İzni tamamen atlamanın yolu yok: Ekran Kaydı, MDM profiliyle bile önceden VERİLEMEYEN
(yalnız reddedilebilen) tek izin sınıfı. Ama derlemeden bağımsız, **sabit bir kimlikle**
imzalanırsa gereksinim şu hâle gelir ve izin kalıcı olur:

```
designated => identifier "com.nurullahyayan.copyboard.tauri" and certificate leaf = H"…"
```

Bunun için $99'lık Apple hesabı gerekmiyor; kendinden imzalı bir sertifika yeter
(yalnız BU makinede geçerli — dağıtım için değil, geliştirme için).

**1. Sertifika oluştur (bir kez):** Keychain Access → menü *Keychain Access →
Certificate Assistant → Create a Certificate…*

| Alan | Değer |
|---|---|
| Name | `CopyBoard Dev` |
| Identity Type | Self Signed Root |
| Certificate Type | **Code Signing** |

Oluşan sertifikaya çift tıkla → *Trust* → *Code Signing: Always Trust* (parola ister).
Doğrulama — bir kimlik listelenmeli:

```bash
security find-identity -v -p codesigning
```

**2. Tauri'ye söyle (bir kez):** `~/.zshrc` dosyasına:

```bash
export APPLE_SIGNING_IDENTITY="CopyBoard Dev"
```

Tauri, `signingIdentity` yapılandırmada boşsa bu değişkeni kullanır — yapılandırmaya
makineye özgü bir değer yazmak gerekmez, CI de etkilenmez.

**3. Derle ve doğrula:**

```bash
npm run build -- --bundles app
codesign -d -r- src-tauri/target/release/bundle/macos/CopyBoard.app
```

Çıktı `cdhash` değil şunu demeli:

```
designated => identifier "com.nurullahyayan.copyboard.tauri" and certificate leaf = H"…"
```

İzni bir kez ver; sonraki derlemeler aynı kimliği taşıdığı için yeniden sormaz.
*Sistem Ayarları → Gizlilik ve Güvenlik → Ekran Kaydı*'nda biriken eski "CopyBoard"
girdileri `−` ile silinebilir.

**Bu makinede doğrulandı.** Üç ayrı derleme (kaynak değiştirilip yeniden derlenerek,
yani binary hash'i her seferinde farklı) aynı gereksinimi üretti:

| | Belirlenmiş gereksinim |
|---|---|
| İmzasız (önce) | `cdhash H"029b5567…"` — her derlemede DEĞİŞİR |
| `CopyBoard Dev` ile (sonra) | `identifier "com.nurullahyayan.copyboard.tauri" and certificate leaf = H"998278a1…"` — 3/3 derlemede AYNI |

### Yerel derlemede DMG neden başarısız oluyor (`-1743`)

`npm run build` (bayraksız) `.app`i imzaladıktan sonra DMG üretmeye geçiyor ve orada
duruyor:

```
execution error: Not authorized to send Apple events to Finder. (-1743)
Failed running AppleScript
```

İronik biçimde bu, uygulamanın kendisinden kaldırdığımız hata sınıfının aynısı — ama
bu kez hatayı veren uygulama değil, **derleme betiği**: `bundle_dmg.sh`, DMG
penceresini süslemek (ikon konumları, arka plan) için Finder'a AppleScript gönderiyor
ve derlemeyi başlatan sürecin Otomasyon izni yok.

Üç seçenek:

1. **Yerel geliştirmede DMG'ye gerek yok** — `.app` yeterli:
   ```bash
   npm run build -- --bundles app
   ```
2. **Sürüm çıkarırken** derlemeyi Terminal.app'ten bir kez çalıştır; macOS
   *"Terminal, Finder'ı kontrol etmek istiyor"* diyaloğunu gösterir, *İzin Ver*
   dedikten sonra kalıcı olur (*Ayarlar → Gizlilik ve Güvenlik → Otomasyon*).
3. **CI'da sorun çıkmaz** — GitHub Actions runner'ında Otomasyon izni istenmiyor.

Betiği yamamak işe yaramaz: `tauri-bundler` onu her derlemede `target/` altına
yeniden yazıyor.

Not: `bundle_dmg.sh` üstüste başarısız olursa `/Volumes/dmg.XXXXXX` altında bağlı
birimler bırakabiliyor. Zararsız ama birikirler; `hdiutil detach /Volumes/dmg.XXXXXX`
ile ayrılır.

### Bekçi: imzasız derleme sessizce geçmiyor

`APPLE_SIGNING_IDENTITY` tanımlı değilse Tauri paketi **sessizce** ad-hoc imzalar —
hata yok, uyarı yok, sadece çıktıdan `Signing with identity` satırları eksilir. Bu tam
olarak başımıza geldi: değişken `~/.zshrc`'ye eklendi ama derleme, o düzenlemeden ÖNCE
açılmış bir terminalde çalıştırıldığı için imzasız çıktı ve fark edilmedi.

`scripts/check-signing-identity.sh`, `beforeBundleCommand` olarak paketleme öncesi
çalışıyor (yalnız macOS: `src-tauri/tauri.macos.conf.json`; Windows'ta düz `bash`
WSL'e gidip dağıtım yoksa derlemeyi düşürüyordu) ve üç durumu ayırıyor:

| Durum | Sonuç |
|---|---|
| Değişken yok | Derleme **durur**, ne yapılacağını yazar |
| Değişken var ama anahtarlıkta yok | Derleme **durur**, mevcut kimlikleri listeler |
| Kimlik geçerli | `İmzalama kimliği doğrulandı: …` yazıp devam eder |

Bilerek imzasız derlemek için `COPYBOARD_ALLOW_UNSIGNED=1`. CI
(`release-tauri.yml`) bu muafiyeti yalnız ne sertifikanın ne güncelleme anahtarının
tanımlı olduğu ortamda (ör. bir fork) kullanıyor; normal yayında kimlik geçici
anahtarlıktan geliyor.

CI'da betik `security find-identity`'yi `-v` OLMADAN çağırıyor: `-v` yalnız
güvenilen kimlikleri listeliyor ve geçici anahtarlıktaki sertifikaya güven ayarı
yok — bekçi, `codesign`'ın sorunsuz kullanacağı bir kimliği "yok" sanıp yayını
durdururdu. Yerelde `-v` kalıyor.

Notlar:

* `npm run dev` / `cargo run` ile çalışan **çıplak binary** için durum farklı: macOS
  izni genelde onu başlatan "sorumlu sürece" (Terminal, VS Code) yazar; o uygulamaya
  bir kez verilen izin derlemeler arasında kalır. Yeniden sorma sorunu esas olarak
  `.app` paketini Finder'dan/`open` ile açarken yaşanır.
* Dağıtım için Developer ID ile imzalanan uygulama **ayrı bir kimliktir** — onun için
  de bir kez izin istenir; beklenen davranış.
* macOS 15+ ekran kaydı yapan uygulamalar için aralıklı bir "izin vermeye devam et"
  hatırlatması gösterir. Bu Ayarlar'a gitmeyi gerektirmeyen tek tıklık bir diyalog ve
  Apple'ın sistem seçicisini kullanmayan her uygulamada çıkıyor — imzayla ilgisi yok.

---

## 3. Windows kod imzası

Şu an imzasız. SmartScreen uyarısı çıkabilir. Sertifika varsa:

```json
"bundle": { "windows": { "certificateThumbprint": "...", "digestAlgorithm": "sha256", "timestampUrl": "http://timestamp.digicert.com" } }
```

`scripts/generate-pfx-and-secrets.ps1` Electron sürümünden kalma; Tauri'nin
`certificateThumbprint` alanına uyarlanması gerekiyor.
