# Faz 0 — Doğrulama Spike'ları

Bu dizindeki her proje, [Tauri göç planının](../docs/TAURI_MIGRATION_PLAN.md) §6'sındaki
**tek bir soruyu ölçerek** yanıtlar. Hiçbiri ürün kodu değildir; hepsi göç bittiğinde silinir.

Kural: bir spike "çalışıyor gibi görünüyor" demez — **sayı veya ekran görüntüsü üretir.**

| Spike | Soru | Çalıştırma | Durum |
|---|---|---|---|
| `s1-windows` | S1/S2/S7 — 6 pencere tipinin bayrakları, focusable:false odak, initialization_script sırası | `cd s1-windows/src-tauri && cargo run -- --auto` | ✅ **GEÇTİ** |
| `s3-capture` | S3 — xcap çok monitör / çok DPI kalitesi, ilk kare, encode maliyeti | `cd s3-capture && cargo run --release -- ./out` | ✅ **GEÇTİ** |
| `s8-hotkey` | S8 — Carbon RegisterEventHotKey + Tauri global-shortcut bir arada | `cd s8-hotkey/src-tauri && cargo run` | ✅ **GEÇTİ** — gerçek tuşla |
| `s4-recorder` | S4 — kırpılmış, sistem sesli mp4 (kapı spike'ı) | `cd s4-recorder && cargo run --release --bin s4-recorder -- 6`<br>`cargo run --release --bin stage_c -- 8 /tmp/out.mp4` | ✅ **GEÇTİ** |
| `s6-ocr` | S6 — tesseract-rs eng+tur kalitesi, süre, bellek | `cd s6-ocr && cargo run --release -- görüntü.png` | ✅ **GEÇTİ** |
| `s5-stream` | S5 — Kırpma bölgesi kare akışı Channel'da 15 fps | `cd s5-stream/src-tauri && cargo run --release -- --auto` | ✅ **GEÇTİ** |

📄 **Ölçülmüş sonuçlar ve bulgular: [../docs/TAURI_SPIKE_RESULTS.md](../docs/TAURI_SPIKE_RESULTS.md)**

### 🟢 Faz 0 tamamlandı (macOS/Windows çekirdeği)

**Yedi spike, yedi geçiş, dokuz bulgu.** Projeyi durdurabilecek tek risk — video kaydı —
ölçümle kapatıldı: kırpılmış, sistem sesli, oynatılabilir H.264/mp4 üretildi.
Kaydırmalı yakalamanın kare akışı 234 MB/sn'de sıfır kare düşümüyle aktı; `stitcher.js`
Rust'a portlanmayacak.

### En önemli bulgular

1. **AppKit FFI ana thread zorunlu.** `NSWindow.setLevel` worker thread'den çağrılınca süreç
   SIGTRAP ile ölüyor. Tüm `platform/macos/*` çağrıları `run_on_main_thread` içinden gitmeli.
2. **Performans ölçümü release'te alınmalı.** Debug'da PNG encode 2890 ms, release'te 34 ms — 85 kat.
3. **macOS'ta sistem sesi artık BlackHole istemiyor** — ScreenCaptureKit doğrudan veriyor. Kazanım.
4. **Swift runtime rpath'i elle eklenmeli** (`-Wl,-rpath,/usr/lib/swift`), yoksa dyld hatası.
5. **`avassetwriter` crate'i macOS 26 SDK'sıyla derlenmiyor** → `objc2-av-foundation` doğrudan.
6. **Tauri global-shortcut handler'ı basma VE bırakmada tetikleniyor** — `event.state != Pressed`
   filtresi olmazsa yedi kısayolun tamamı iki kez çalışır (bir basışta iki ekran görüntüsü).
7. **Sıkıştırmak akışı yavaşlatıyor** — JPEG trafiği 37 kat azaltıyor ama kare hızını 14,8→8,9
   düşürüyor. Tauri'nin ham byte IPC'si (234 MB/sn ölçüldü) encode CPU'sundan ucuz.
8. **Frontend release binary'ye gömülü** — HTML değişikliği için yeniden derlemek gerekir;
   geliştirmede `cargo tauri dev` kullanın.

Linux spike'ları (S9–S11) bir Linux makinesi/VM gerektirir, ayrıca ele alınacak.

## Ön koşullar

Tauri tabanlı spike'lar (`s1`, `s5`, `s8`) derlemek için bir ikon istiyor; depoda
üç kopya tutmamak için dışlandı. Çalıştırmadan önce:

```bash
for d in s1-windows s5-stream s8-hotkey; do
  mkdir -p "$d/src-tauri/icons" && cp ../icon.png "$d/src-tauri/icons/icon.png"
done
```

```bash
rustup --version    # 1.98.0 ile doğrulandı
cmake --version     # yalnız s6-ocr için (4.4.3 tarball'ı scratchpad'e açıldı)
```

macOS'ta ilk çalıştırmada **Ekran Kaydı** izni istenecektir
(Sistem Ayarları → Gizlilik ve Güvenlik → Ekran Kaydı).
