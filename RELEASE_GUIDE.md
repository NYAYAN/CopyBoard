# Sürüm Çıkarma

## Ön koşullar

| | |
|---|---|
| Rust | `rustup` (stable) |
| **cmake** | `tesseract-rs` Tesseract + Leptonica'yı kaynaktan derliyor. GitHub Actions imajlarında hazır gelir; yerelde `brew install cmake` ya da [cmake.org](https://cmake.org/download/) |
| Node | 20+ (yalnız Tauri CLI için) |
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

1. Sürüm numarasını **iki yerde** güncelle:
   * `src-tauri/tauri.conf.json` → `version`
   * `src-tauri/Cargo.toml` → `[package] version`
2. `CHANGELOG.md` ve `RELEASE_NOTES.md`'yi güncelle.
3. Etiketle ve gönder:

   ```bash
   git tag v3.0.0
   git push origin v3.0.0
   ```

4. CI (`.github/workflows/release.yml`) üç yapı üretir — macOS arm64, macOS x64,
   Windows — ve bir **taslak** release'e ekler. `latest.json` ve `.sig` dosyaları da
   oraya konur (güncelleyici bunları okuyor) — **yalnız** imza secret'ları tanımlıysa;
   değilse Windows/macOS yapıları imza adımında düşer (bkz. [SIGNING.md](SIGNING.md)).
5. Taslağı gözden geçirip yayınla.

## Güncelleyici

> **⚠ İlk sürümden ÖNCE yapılması gereken:** güncelleyici imza anahtar çifti **henüz
> üretilmedi** (4 Eylül 2026'da bilerek ertelendi). Bunun iki sonucu var:
>
> * Her `npm run build` şu satırla bitiyor — paket üretiliyor, yalnız çıkışta hata
>   basılıyor: `A public key has been found, but no private key.`
> * CI'daki sürüm iş akışı `TAURI_SIGNING_PRIVATE_KEY` secret'ını okuyor; anahtar
>   olmadan **release yapıları imza adımında düşer.**
>
> Anahtar tek yönlü bir karar: açık anahtar bir kez yayınlanmış sürüme girdikten sonra
> değiştirilemez — değiştirmek mevcut tüm kurulumların otomatik güncellemesini kalıcı
> olarak kırar. Üretim adımları [SIGNING.md](SIGNING.md) §1'de.

`plugins.updater.pubkey` boşsa güncelleyici "yapılandırılmamış" sayılır: açılış
kontrolü atlanır, elle kontrol bir uyarı toast'ı gösterir; uygulama normal çalışır.

Windows'ta akış Electron'daki gibi: indir → "İndirme Tamamlandı" → 3-2-1 geri sayım
(Daha Sonra ile iptal edilebilir) → NSIS sessiz kurulum ve yeniden başlatma.

## Günlük dosyası

Kullanıcıdan sorun kaydı isterken:

* macOS: `~/Library/Logs/com.nurullahyayan.copyboard/copyboard.log`
* Windows: `%LOCALAPPDATA%\com.nurullahyayan.copyboard\logs\copyboard.log`

Dosya 4 MB'a kadar büyür, dolunca sıfırlanır; renderer'ın `console.warn/error`
çıktıları da buraya düşer.

## v2 (Electron) → v3 (Tauri) geçişi

`electron-updater` Tauri paketini kuramaz. Geçiş **elle indirme** ile yapılıyor:
v2.12.1, güncelleme diyaloğunu "yeni altyapı, bir kez elle indirin" mesajıyla
GitHub release'e yönlendirecek şekilde çıkarılır.

Kullanıcı verisi ilk açılışta **kopyalanıyor** (taşınmıyor): Electron'un
`~/Library/Application Support/copyboard` dizini olduğu yerde kalıyor, yani
v2'ye geri dönüş her an mümkün.
