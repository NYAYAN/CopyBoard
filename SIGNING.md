# İmzalama

CopyBoard'da **iki ayrı imza** var ve karıştırılmamalı.

| | Ne için | Zorunlu mu |
|---|---|---|
| **Tauri güncelleyici imzası** | Güncellemenin bizden geldiğini doğrular | Güncelleme özelliği için **evet** |
| **İşletim sistemi kod imzası** (Apple / Authenticode) | Gatekeeper / SmartScreen uyarısını kaldırır | Hayır — uygulama imzasız da çalışır |

---

## 1. Tauri güncelleyici imzası

Tauri'nin güncelleyicisi **imzasız güncelleme kabul etmez** ve bu kapatılamaz.
Apple/Microsoft ile hiçbir ilgisi yoktur; Tauri'nin kendi anahtar çiftidir.

### Anahtar üretimi (bir kez)

```bash
npx tauri signer generate -w ~/.tauri/copyboard.key
```

Bu iki şey üretir:

* **Özel anahtar** (`~/.tauri/copyboard.key`) — **ASLA depoya girmez.**
* **Genel anahtar** — çıktıda basılır.

### Kurulum

1. Genel anahtarı `src-tauri/tauri.conf.json` içine yaz:

   ```json
   "plugins": { "updater": { "pubkey": "<genel anahtar>" } }
   ```

   > Alan şu an **boş**. Boşken uygulama "güncelleyici yapılandırılmamış" sayıyor:
   > açılış kontrolü atlanır, elle kontrol anlaşılır bir uyarı toast'ı verir (ham
   > minisign hatası değil). Yapılandırma bölümünün tamamı silinirse uygulama
   > açılışta panikler (BULGU F5-a), o yüzden bölümü silme — yalnız `pubkey`'i doldur.

2. Özel anahtarı ve parolasını GitHub deposunda **Secrets** olarak ekle:

   | Secret | Değer |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | özel anahtar dosyasının İÇERİĞİ |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | üretirken verdiğin parola |

`tauri.conf.json` içinde `bundle.createUpdaterArtifacts: true` açık. Bu bayrak
olmadan `tauri build` hiç `.sig` üretmiyor ve tauri-action `latest.json`ı release'e
**yazmıyordu** — güncelleyici hiçbir sürümde çalışamazdı. Bayrağın bedeli: imza
anahtarı **zorunlu**. Secret'lar yoksa CI'daki `tauri build` imza adımında hata verir;
yerelde `tauri build` almak için de aynı iki değişkeni ortama ver (ya da yalnız
`tauri dev` kullan).

---

## 2. macOS kod imzası

Uygulama şu an **imzasız** dağıtılıyor (Electron sürümündeki `identity: null` ile aynı
politika). Sonuçları:

* Kullanıcı ilk açılışta Gatekeeper uyarısı görür (sağ tık → Aç ile geçilir).
* Güncelleyici macOS'ta **kapalı**: `download_update` ve `install_update` baştan
  reddediyor, güncelleme diyaloğu kullanıcıyı GitHub'dan elle indirmeye yönlendiriyor.

Apple Developer sertifikası ($99/yıl) alınırsa:

```json
"bundle": { "macOS": { "signingIdentity": "Developer ID Application: ...", "providerShortName": "..." } }
```

ve notarization eklenir. macOS'ta uygulama içi güncelleme ancak bundan sonra açılabilir.

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
designated => identifier "com.nurullahyayan.copyboard" and certificate leaf = H"…"
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
designated => identifier "com.nurullahyayan.copyboard" and certificate leaf = H"…"
```

İzni bir kez ver; sonraki derlemeler aynı kimliği taşıdığı için yeniden sormaz.
*Sistem Ayarları → Gizlilik ve Güvenlik → Ekran Kaydı*'nda biriken eski "CopyBoard"
girdileri `−` ile silinebilir.

**Bu makinede doğrulandı.** Üç ayrı derleme (kaynak değiştirilip yeniden derlenerek,
yani binary hash'i her seferinde farklı) aynı gereksinimi üretti:

| | Belirlenmiş gereksinim |
|---|---|
| İmzasız (önce) | `cdhash H"029b5567…"` — her derlemede DEĞİŞİR |
| `CopyBoard Dev` ile (sonra) | `identifier "com.nurullahyayan.copyboard" and certificate leaf = H"998278a1…"` — 3/3 derlemede AYNI |

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

### Güncelleyici anahtarı üretilmeden derleme sonunda hata çıkıyor

`npm run build` şu satırla bitiyor:

```
Error A public key has been found, but no private key. Make sure to set
`TAURI_SIGNING_PRIVATE_KEY` environment variable.
```

`tauri.conf.json`'daki `plugins.updater.pubkey` BOŞ olmasına rağmen bundler
güncelleyici yapıtını (`.app.tar.gz`) imzalamaya çalışıyor. Paket üretilmiş oluyor,
yalnız çıkışta bu hata basılıyor. §1'deki anahtar üretilip `TAURI_SIGNING_PRIVATE_KEY`
verilince geçiyor.

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
