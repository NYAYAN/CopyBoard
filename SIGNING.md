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

---

## 3. Windows kod imzası

Şu an imzasız. SmartScreen uyarısı çıkabilir. Sertifika varsa:

```json
"bundle": { "windows": { "certificateThumbprint": "...", "digestAlgorithm": "sha256", "timestampUrl": "http://timestamp.digicert.com" } }
```

`scripts/generate-pfx-and-secrets.ps1` Electron sürümünden kalma; Tauri'nin
`certificateThumbprint` alanına uyarlanması gerekiyor.
