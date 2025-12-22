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

Workflow dosyası repo'ya eklendi: `.github/workflows/release.yml` — bu dosya Windows runner üzerinde `npm run build` yaptıktan sonra `cert.pfx`'i çözüp `signtool` ile `dist/*.exe` dosyalarını imzalar ve Release'e yükler.

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

