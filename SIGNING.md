Kod imzalama ve dağıtım — hızlı rehber

Amaç
- Windows için installer (.exe) SmartScreen/AV sorunlarını azaltmak ve kullanıcı güveni sağlamak.

Adımlar (yaygın, pratik)

1) Sertifika alın
- Bir code-signing PFX alın. EV (Extended Validation) sertifikası SmartScreen itibarını daha hızlı iyileştirir.

2) Yerel olarak test için `signtool` kullanın (Windows SDK ile gelir)
- İmzalama komutu (PowerShell):

```powershell
signtool sign /fd SHA256 /a /f "C:\path\to\cert.pfx" /p "PFX_PASSWORD" "dist\CopyBoard Setup 1.0.0.exe"
```

- İmzayı doğrulayın:

```powershell
Get-AuthenticodeSignature -FilePath "dist\CopyBoard Setup 1.0.0.exe" | Format-List
```

3) `electron-builder` ile CI ortamında imzalama
- CI'de `CSC_LINK` olarak PFX URL'si veya yükleme yolu ve `CSC_KEY_PASSWORD` ortam değişkenlerini ayarlayın.
- `package.json` veya `electron-builder` config örneği:

```json
"build": {
  "win": {
    "target": "nsis"
  }
}
```

- CI pipeline örneği (GitHub Actions): PFX'i `secrets` içine koyup `CSC_LINK` olarak erişilebilir hale getirin.
  - CI pipeline örneği (GitHub Actions): PFX'i base64 olarak `secrets.PFX_BASE64` içine koyup `PFX_PASSWORD` olarak parola saklayın. Aşağıdaki workflow örneğini repo'ya ekleyerek otomatik imzalama ve GitHub Release yüklemeyi sağlayabilirsiniz: `.github/workflows/release.yml`.

4) Yayın ve itibar
- GitHub Releases veya benzeri güvenilir dağıtım kanallarından yayınlayın.
- İlk dağıtımlarda SmartScreen uyarısı görebilirsiniz; EV sertifikası + düzenli indirme sayısı ile zaman içinde azalır.

5) Hedef makinede doğrulama
- Sağ tık → Özellikler → "Unblock" varsa işaretleyin.
- "Run as administrator" deneyin.
- Event Viewer -> Windows Logs -> Application/Setup hatalarını kontrol edin.

Notlar
- Sertifika parola ve PFX dosyalarını repoya koymayın. CI/secret manager kullanın.
- `electron-builder` dokümantasyonu: https://www.electron.build/

GitHub Actions için hızlı yönergeler
- Secrets oluşturun:
  - `PFX_BASE64`: PFX dosyanızın base64 içerği (örnek PowerShell ile elde edin: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`)
  - `PFX_PASSWORD`: PFX parolası
  - `GITHUB_TOKEN`: otomatik olarak sağlanır

- Tag ile release oluşturun: `git tag v1.0.0 && git push --tags` — bu tetikleyecek `v*` patternli workflow'u.

Workflow dosyası: `.github/workflows/release.yml` — Windows runner'da `npm run dist` çalışırken `PFX_BASE64` secret'ı `WIN_CSC_LINK`, `PFX_PASSWORD` secret'ı `WIN_CSC_KEY_PASSWORD` ortam değişkeni olarak verilir. Secret'lar mevcutsa electron-builder NSIS installer'ı imzalar; yoksa boş kalır ve build imzasız üretilir (`forceCodeSigning: false`). Ayrı bir `signtool` adımı gerekmez.

Mevcut durum: UYGULAMA İMZASIZ
- `package.json` → `build.win`: `verifyUpdateCodeSignature: false`, `forceCodeSigning: false`. Yani sürümler imzasız çıkıyor ve otomatik güncelleme GitHub HTTPS + electron-updater'ın paket meta verisindeki SHA-512 bütünlük kontrolü ile korunuyor (yayıncı kimlik doğrulaması yok, ama bozuk/eksik indirme yine yakalanır).

⛔ Neden imza doğrulaması (`verifyUpdateCodeSignature`) şu an KAPALI ve self-signed ile AÇILMAMALI
- electron-updater (v6.x) indirilen Windows güncellemesini `Get-AuthenticodeSignature` ile doğrular ve CN karşılaştırmasını **yalnızca** imza durumu `Valid (0)` ise yapar (`windowsExecutableCodeSignatureVerifier.ts`).
- Self-signed sertifika son kullanıcının makinesinde Trusted Root/Trusted Publishers'ta **olmadığı** için durum `NotTrusted (4)` döner → doğrulama **başarısız** olur → her güncelleme `ERR_UPDATER_INVALID_SIGNATURE` ile **reddedilir**.
- Sonuç: CA imzalı (OV/EV) bir sertifika olmadan `verifyUpdateCodeSignature: true` yapmak, tüm kullanıcılar için otomatik güncellemeyi **kırar**. Bu yüzden kapalı bırakıldı. (Kaynak: electron-builder/electron-updater kaynak kodu + GHSA-9jxc-qjr9-vjxq.)

✅ CA sertifikası edindiğinde imzalama + doğrulamayı açma adımları
1. GitHub secret'larını ayarla: `PFX_BASE64` (cert.pfx base64'ü, sonunda boşluk/yenisatır olmadan, < 8192 karakter) ve `PFX_PASSWORD`.
2. `package.json` → `build.win`'de `verifyUpdateCodeSignature: true` ve `forceCodeSigning: true` yap.
3. `build.win.publisherName`'i sertifikanın **subject CN**'i ile birebir eşleşecek şekilde pinle, ör: `"publisherName": ["Nurullah YAYAN"]` (dizi, ileride sertifika rotasyonunu köprülemeyi kolaylaştırır).
4. İlk imzalı sürümden sonra installer içindeki `resources/app-update.yml`'da `publisherName:` satırının gerçekten yazıldığını doğrula (boşsa doğrulama sessizce no-op olur; electron-builder #1913/#2875/#3507).
5. CN'i sürümler arası **sabit** tut; değiştirmek (ör. farklı CA'ya geçiş) eski istemcilerde güncellemeleri reddettirir.

Notlar
- Self-signed sertifika SmartScreen güvenini sağlamaz; ilk kurulumda "bilinmeyen yayıncı" uyarısı için yine gerçek/EV sertifika gerekir.
- macOS: `mac.identity = null` (imzasız). Güncelleme penceresi mac kullanıcılarını "İndir (GitHub)" ile elle indirmeye yönlendirir (`src/renderer/update/update-dialog.js`) ve ana süreç mac'te in-app indirme/kurulumu atlar (`src/main/services/update-manager.js`) — yani başarısız bir kuruluma sokulmazlar. Gerçek mac otomatik güncellemesi Apple Developer ID + notarization gerektirir, ayrıca ele alınmalı.

Yerel yardımcı komut dosyası
- Repo içinde `scripts/generate-pfx-and-secrets.ps1` adlı PowerShell script'i eklendi. Bu script:
  - self-signed bir code-signing sertifikası oluşturur,
  - `cert.pfx` olarak dışarı aktarır,
  - `pfx.base64.txt` oluşturur ve base64 içeriği panoya kopyalar,
  - isteğe bağlı olarak `gh` CLI ile `PFX_BASE64` ve `PFX_PASSWORD` secrets'larını hedef repo'ya yazar,
  - yereldeki `cert.pfx` ve `pfx.base64.txt` dosyalarını silebilir.

Kullanım (PowerShell, repo kökünde):
```powershell
.\scripts\generate-pfx-and-secrets.ps1
```

Uyarı: script çalıştırıldıktan sonra `cert.pfx` ve `pfx.base64.txt` dosyalarını asla repoya commit etmeyin. Secrets ayarlandıktan sonra yerel kopyaları silin.

