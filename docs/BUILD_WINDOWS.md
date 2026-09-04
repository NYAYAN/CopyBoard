# Windows'ta derleme ve çalıştırma (Tauri sürümü)

Kısa yol, repo kökünden:

```bat
scripts\win-env.cmd cargo run
```

Betik uygun Visual Studio kurulumunu bulur, MSVC ortamını kurar, gerekirse VS'nin cmake'ini
PATH'e ekler, `src-tauri` dizinine geçer ve komutu çalıştırır. Soğukta ilk derleme yaklaşık
10 dakika sürer (Tesseract + Leptonica kaynaktan derleniyor); sonrakiler 20–30 saniye.

## Gereksinimler

| Ne | Neden | Nasıl |
|---|---|---|
| Rust (stable, **msvc** hedefi) | Ana süreç Rust | [rustup](https://rustup.rs); `rustup default stable-x86_64-pc-windows-msvc` |
| Visual Studio 2022 (herhangi edisyon) **veya** Build Tools, "Desktop development with C++" iş yükü | Linker, C/C++ derleyici, Windows SDK | Visual Studio Installer. Bileşenler: MSVC v143 x64/x86, Windows 10/11 SDK, **C++ CMake tools for Windows** |
| cmake | `tesseract-rs` (OCR) ve `aws-lc-sys` (güncelleyicinin TLS'i) kaynaktan derleniyor | Yukarıdaki VS bileşeni yeter; ya da [cmake.org](https://cmake.org/download/) kurulumu PATH'te |
| WebView2 Runtime | Arayüz | Windows 11'de hazır; Windows 10'da [Evergreen](https://developer.microsoft.com/microsoft-edge/webview2/) |
| Node.js 20+ ve `npm ci` | Yalnız `npx tauri dev`, `npm run build`, `npm test` için | `cargo run` için gerekmez |

nasm gerekmez (bu makinede debug ve release nasm'sız derlendi).

## Komutlar

```bat
scripts\win-env.cmd cargo run                      # debug derle ve çalıştır
scripts\win-env.cmd cargo build --release          # src-tauri\target\release\copyboard.exe
scripts\win-env.cmd cargo test --lib               # Rust birim testleri
scripts\win-env.cmd npx tauri dev -- -- --qa       # kendini-sınama (yalnız debug)
npm test                                           # JS testleri
```

Debug exe (`src-tauri\target\debug\copyboard.exe`) tek başına çalışır; arayüz dosyaları
gömülüdür, dev sunucusu gerekmez. Yararlı bayraklar (debug): `--qa`, `--record-test=ultra,20`,
`--copy-test=<metin>`, `--viewer`; release'te de çalışan: `--shot-test`.

Günlük: `%LOCALAPPDATA%\com.nurullahyayan.copyboard\logs\copyboard.log`

## Sık hatalar

| Belirti | Neden | Çözüm |
|---|---|---|
| `could not find Cargo.toml in ...` | `cargo` repo kökünde çalıştırıldı | `scripts\win-env.cmd cargo run` (betik `src-tauri`ye geçer) ya da `cd src-tauri` |
| `failed to run custom build command for tesseract-rs` ve içinde `cmake` / `program not found` | cmake yok | "C++ CMake tools for Windows" bileşeni ya da cmake.org kurulumu; betiği kullanın |
| `failed to run custom build command for aws-lc-sys` | cmake yok (aynı neden) | Aynı çözüm |
| `linker 'link.exe' not found` | MSVC yok ya da ortam kurulmadı | VS C++ iş yükü; komutu `win-env.cmd` üzerinden verin |
| `LNK1104: cannot open file 'msvcrt.lib'` | Eksik/yarım VS kurulumu seçildi | Betik `msvcrt.lib`i olan kurulumu seçer; gerekirse `set COPYBOARD_VS=<kurulum yolu>` |
| `HATA: MSVC C++ araclari olan bir Visual Studio ... bulunamadi` | Hiç C++ araç seti yok | VS Installer'dan "Desktop development with C++" |
| `error: toolchain ... windows-gnu` | GNU araç zinciri seçili | `rustup default stable-x86_64-pc-windows-msvc` |
| Pencereler boş / `asset not found` sel gibi | `src/renderer` yok ya da eski derleme | Depo tam mı bakın; `cargo clean -p copyboard` sonra yeniden |
| Uygulama açılıyor, kısayollar çalışmıyor | Electron sürümü (`C:\Program Files\CopyBoard`) çalışıyor, kısayollar onda | Electron'u kapatın |
| Windows 10'da arayüz açılmıyor | WebView2 Runtime yok | Evergreen runtime kurun |

## Doğrulama

Derleme bittikten sonra:

```bat
scripts\win-env.cmd cargo test --lib
src-tauri\target\debug\copyboard.exe --qa
```

`--qa` sonucu günlükte `QA ✓/✗` satırları, sonda `QA bitti: 0 başarısız adım` beklenir
(bkz. `docs/QA_WINDOWS.md`).
