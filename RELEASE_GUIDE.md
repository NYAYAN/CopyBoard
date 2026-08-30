# Sürüm Çıkarma

## Ön koşullar

| | |
|---|---|
| Rust | `rustup` (stable) |
| **cmake** | `tesseract-rs` Tesseract + Leptonica'yı kaynaktan derliyor. GitHub Actions imajlarında hazır gelir; yerelde `brew install cmake` ya da [cmake.org](https://cmake.org/download/) |
| Node | 20+ (yalnız Tauri CLI için) |
| macOS | 12.3+ SDK (ScreenCaptureKit) |

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
   Windows — ve bir **taslak** release'e ekler. `latest.json` da oraya konur
   (güncelleyici bunu okuyor).
5. Taslağı gözden geçirip yayınla.

## Güncelleyici

`plugins.updater.pubkey` boşsa güncelleme kontrolü temiz bir hata verir; uygulama
normal çalışır. Anahtar kurulumu için [SIGNING.md](SIGNING.md).

## v2 (Electron) → v3 (Tauri) geçişi

`electron-updater` Tauri paketini kuramaz. Geçiş **elle indirme** ile yapılıyor:
v2.12.1, güncelleme diyaloğunu "yeni altyapı, bir kez elle indirin" mesajıyla
GitHub release'e yönlendirecek şekilde çıkarılır.

Kullanıcı verisi ilk açılışta **kopyalanıyor** (taşınmıyor): Electron'un
`~/Library/Application Support/copyboard` dizini olduğu yerde kalıyor, yani
v2'ye geri dönüş her an mümkün.
