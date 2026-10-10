# Sürüm Çıkarma

## Ön koşullar

| | |
|---|---|
| Rust | `rustup` (stable) |
| **cmake** | `tesseract-rs` Tesseract + Leptonica'yı kaynaktan derliyor. GitHub Actions imajlarında hazır gelir; yerelde `brew install cmake` ya da [cmake.org](https://cmake.org/download/) |
| Node | 22+ — `npm test` `node --test`'in glob desteğini kullanıyor (Node 21'de geldi; 20'de testler hiç koşmuyor) |
| macOS | 12.3+ SDK (ScreenCaptureKit) |
| Windows | VS 2022 / Build Tools C++ iş yükü + cmake; `scripts\win-env.cmd` ortamı kurar — bkz. [docs/BUILD_WINDOWS.md](docs/BUILD_WINDOWS.md) |

## Yerel yapı

```bash
npm ci
npm run build              # tauri build — dmg + app (macOS), nsis (Windows)
```

Çıktılar: `src-tauri/target/release/bundle/`

Yalnız `.app` (hızlı, imzasız deneme):

```bash
npx tauri build --bundles app
```

## Sürüm yayınlama

1. Sürüm numarasını **beş yerde** güncelle:
   * `package.json` → `version`
   * `package-lock.json` → kökteki ve `packages[""]` içindeki `version`
   * `src-tauri/Cargo.toml` → `[package] version`
   * `src-tauri/Cargo.lock` → `name = "copyboard"` girdisinin `version`'ı
   * `src-tauri/tauri.conf.json` → `version`
2. `CHANGELOG.md`'nin başına `# CopyBoard vX.Y.Z Release Notes` bölümünü yaz, sonuna
   `---` koy. Bu bölüm hem release gövdesi hem de kurulu uygulamanın güncelleme
   diyaloğunda gösterilen not. **Bölüm yoksa yayın durur.**
3. Etiketle ve gönder — önek **`tauri-v`**:

   ```bash
   git tag tauri-v3.2.0
   git push origin tauri-v3.2.0
   ```

   `v*` etiketleri Electron'un `release.yml`'ini tetikler; `tauri-v3.2.0` o desene
   uymuyor, iki yayın akışı birbirine dokunmuyor.

4. CI (`.github/workflows/release-tauri.yml`):
   * etiket ile `tauri.conf.json` sürümü aynı mı — değilse durur;
   * JS ve Rust testleri — bozuk bir sürüm kullanıcıya kendiliğinden kurulacağı için
     testler yayından ÖNCE koşuyor;
   * macOS arm64 (**CopyBoard Dev** ile imzalı, imza ölçülerek doğrulanıyor) ve Windows
     NSIS paketleri, güncelleyici için de imzalı (`.sig`);
   * `tauri-vX.Y.Z` **ön sürüm** release'i: DMG, `-setup.exe`, `.app.tar.gz`,
     `latest.json`;
   * sabit `tauri-updater` ön sürümündeki `latest.json` güncellenir ve kanalın yeni
     sürümü gösterdiği ölçülür.

   Taslak yok: release doğrudan yayımlanıyor. Kurulu uygulamalar açılıştan 5 sn
   sonra kanalı okuyup güncelleme diyaloğunu açıyor.

## Güncelleyici

Kurulu uygulama `tauri.conf.json` → `plugins.updater.endpoints`'teki adresi okuyor:

```
https://github.com/NYAYAN/CopyBoard/releases/download/tauri-updater/latest.json
```

**Neden `releases/latest/…` değil:** bu depoda Electron release'leri de yaşıyor ve
Electron'un `electron-updater`'ı GitHub'ın "Latest" release'ine bakıyor. Tauri
release'i "Latest" olsaydı kurulu Electron uygulamaları orada `latest-mac.yml`'i
bulamayıp güncelleme hatası verirdi. Tauri release'leri bu yüzden **ön sürüm**
(GitHub "Latest"e ön sürümleri saymıyor) ve uygulama sabit `tauri-updater` ön
sürümündeki dosyayı okuyor.

**İmza:** paketler minisign ile imzalanıyor; uygulama `plugins.updater.pubkey` ile
doğrulamadan HİÇBİR paketi kurmuyor. Özel anahtar `~/.tauri/copyboard.key`
(parolasız) ve GitHub secret'ı `TAURI_SIGNING_PRIVATE_KEY` — kurulum
[SIGNING.md](SIGNING.md) §1'de.

> **⚠ Özel anahtarı yedekle** (parola yöneticisi gibi güvenli bir yere). Kaybolursa
> ya da `pubkey` değiştirilirse kurulu uygulamaların hiçbiri bir sonraki sürümü
> doğrulayamaz: herkes bir kez daha elle kurmak zorunda kalır.

**Akış:** diyalog → **Güncelle** → indirme (ilerleme çubuğu) → imza doğrulaması →
"İndirme Tamamlandı" → 3-2-1 geri sayım (**Daha Sonra** ile iptal edilebilir) →

* **macOS:** `.app` paketi yerinde değişiyor, uygulama yeni sürümle yeniden açılıyor.
  Paketler aynı "CopyBoard Dev" sertifikasıyla imzalandığı için Ekran Kaydı ve
  Erişilebilirlik izinleri korunuyor.
* **Windows:** NSIS kurucusu `passive` kipte (yalnız ilerleme çubuğu) çalışıp
  uygulamayı yeniden açıyor.

**`createUpdaterArtifacts`** `tauri.conf.json`'da `false`; CI paketlerken
`--config` ile açıyor. Yerelde açık olsaydı özel anahtarı olmayan her
`npm run build` imza isteyip düşerdi.

**3.1.x'ten geçiş:** 3.1.x'te `pubkey` boştu ve güncelleyici çalışmıyordu; 3.2.0 bir
kez elle kurulur, sonrası uygulamanın içinden gelir.

### Güncellemeyi yerelde uçtan uca sınamak

```bash
bash scripts/qa-update-e2e.sh
```

GitHub'a hiçbir şey yüklemeden zinciri gerçek paketlerle koşturur: eski sürüm (hata
ayıklama derlemesi) yerel bir `latest.json`'ı okuyor, yeni sürümü indirip imzasını
DOĞRULUYOR, `.app`'i yerinde değiştiriyor ve yeniden başlıyor. Betik sonunda yeni
sürümün koştuğunu, paketin sürümünü, kök iznini (0755) ve imza gereksiniminin
değişmediğini ölçer; kendi oluşturduğu her şeyi siler.

Test paketleri **ayrı ad ve kimlikle** derleniyor (`CopyBoardUpdateTest`,
`…copyboard.updatetest`). Bu şart: paketli uygulama her açılışta
`~/Library/LaunchAgents/<ürün adı>.plist`'i yeniden yazıyor ya da siliyor
(`sync_autostart`) — `CopyBoard` adıyla açılan bir test kopyası kullanıcının oturum
açma öğesini test yoluna çevirirdi. Ayrı kimlik de verinin ve tek-örnek soketinin
kurulu uygulamayla karışmamasını sağlıyor.

## Günlük dosyası

Kullanıcıdan sorun kaydı isterken:

* macOS: `~/Library/Logs/com.nurullahyayan.copyboard.tauri/copyboard.log`
* Windows: `%LOCALAPPDATA%\com.nurullahyayan.copyboard.tauri\logs\copyboard.log`

Dosya 4 MB'a kadar büyür, dolunca sıfırlanır; renderer'ın `console.warn/error`
çıktıları da buraya düşer.

## v2 (Electron) → v3 (Tauri) geçişi

`electron-updater` Tauri paketini kuramaz. Geçiş **elle indirme** ile yapılıyor:
v2.12.1, güncelleme diyaloğunu "yeni altyapı, bir kez elle indirin" mesajıyla
GitHub release'e yönlendirecek şekilde çıkarılır.

Kullanıcı verisi ilk açılışta **kopyalanıyor** (taşınmıyor): Electron'un
`~/Library/Application Support/copyboard` dizini olduğu yerde kalıyor, yani
v2'ye geri dönüş her an mümkün.
