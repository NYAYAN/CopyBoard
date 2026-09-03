//! Ekran yakalama servisi — `src/main/services/capture-service.js`'in karşılığı.
//!
//! ## Sıra: overlay'ler ÖNCE
//!
//! Her monitörün overlay penceresi HEMEN açılıyor, böylece pencere kurulumu ve sayfa
//! yüklemesi yakalamalarla PARALEL yürüyor — karartma, yakala-sonra-yükle sırasının
//! toplamı yerine ikisinden geç olanı kadar sonra beliriyor. Overlay, kendi ekran
//! görüntüsü gelene dek tamamen şeffaf olduğu için, zaten ekranda olması yakalanan
//! görüntüyü kirletemiyor.
//!
//! ## Kare teslimi
//!
//! Electron `webContents.send('capture-screen', pngBuffer, …)` ile itiyordu. Tauri'nin
//! `emit`'i JSON serialize ediyor — 3,6 MB'lık bir PNG, ~15 MB'lık sayı dizisine
//! dönerdi. Bunun yerine METADATA itiliyor, renderer da kareyi `invoke` ile ÇEKİYOR
//! ([`take_capture_frame`]); `tauri::ipc::Response` ham bayt döndürüyor.
//! `api-tauri.js` bu iki adımı birleştirip `onCaptureScreen`'in eski imzasını koruyor.

// Video kaydı ve kaydırma akışı platform başına ayrı dosyada, AYNI modül adı ve aynı
// imzalarla: `commands/record.rs` hangi platformda olduğunu bilmiyor.
#[cfg(target_os = "macos")]
pub mod recorder;
#[cfg(target_os = "windows")]
#[path = "recorder_win.rs"]
pub mod recorder;
/// Windows kaydının parçaları: MP4 yazıcı (Media Foundation) ve ses (WASAPI).
#[cfg(target_os = "windows")]
pub mod mf_writer;
#[cfg(target_os = "windows")]
pub mod wasapi;
pub mod screenshot;
#[cfg(target_os = "macos")]
pub mod scroll_stream;
#[cfg(target_os = "windows")]
#[path = "scroll_stream_win.rs"]
pub mod scroll_stream;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use crate::geom;
use crate::state::AppState;

/// Aynı anda kaç monitör yakalanacak. Yeterince paralel ki karartma hızlı belirsin,
/// ama sınırlı ki tepe bellek monitör sayısıyla karesel büyümesin.
const CONCURRENCY: usize = 2;

/// Ölçüm: son `begin` anı. `deliver` ve renderer'ın `snip-painted` bildirimi buna göre
/// "+ms" yazar (docs/PERF_WINDOWS.md). Yalnız günlük; davranışı etkilemez.
static CAPTURE_T0: Mutex<Option<std::time::Instant>> = Mutex::new(None);

pub fn elapsed_since_begin_ms() -> Option<u128> {
    CAPTURE_T0.lock().unwrap().map(|t| t.elapsed().as_millis())
}

#[derive(Default)]
pub struct CaptureState {
    /// Overlay etiketi → kapladığı monitör. `snip_ready` gösterimden sonra dikdörtgeni
    /// yeniden uygular ve gerçekleşen konumu günlükler (çok monitör tanısı).
    overlays: Mutex<HashMap<String, geom::MonitorInfo>>,
    /// Pencere etiketi → o pencereye ait kare.
    frames: Mutex<HashMap<String, screenshot::Frame>>,
    /// Pencere etiketi → kaç kez yeniden yakalama istendi.
    retries: Mutex<HashMap<String, u32>>,
    /// Renderer'ı dinleyicisini kurmadan ÖNCE hazırlanan kareler için bekleme odası.
    /// Bkz. [`deliver`].
    pending: Mutex<HashMap<String, CaptureMeta>>,
    /// `window_ready` göndermiş overlay etiketleri.
    ready: Mutex<HashSet<String>>,
}

/// Renderer'a itilen metadata. Kare AYRI çekiliyor.
#[derive(Serialize, Clone)]
pub struct CaptureMeta {
    pub mode: String,
    /// Electron'da video/kaydırma için `chromeMediaSourceId` idi. Tauri'de kaynak
    /// Rust tarafında, ama alan imza uyumu için korunuyor.
    #[serde(rename = "sourceId")]
    pub source_id: String,
    pub quality: String,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "multiMonitor")]
    pub multi_monitor: bool,
}

pub const MAX_RETRIES: u32 = 2;

/// Yakalamayı başlatır. `mode`: `draw` | `ocr` | `color` | `video` | `scroll`.
pub fn start(app: &tauri::AppHandle, mode: &str) {
    // ── macOS ekran kaydı izni ───────────────────────────────────────────────
    #[cfg(target_os = "macos")]
    if !crate::platform::macos::permissions::has_screen_recording() {
        request_screen_permission(app);
        return;
    }

    // ── Platform kapısı: overlay'e GİRMEDEN söyle ───────────────────────────
    // Video kaydı ve kaydırmalı yakalama macOS'ta ScreenCaptureKit, Windows'ta
    // Windows.Graphics.Capture ile var; başka platformda yok. Kapı olmadan kullanıcı
    // tüm ekranları karartıp bölge seçiyor, Kaydet'e basınca "desteklenmiyor" görürdü.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    if matches!(mode, "video" | "scroll") {
        let store = &app.state::<AppState>().store;
        let msg = crate::i18n::t(store, if mode == "video" {
            "Video kaydı bu sürümde yalnız macOS'ta kullanılabilir."
        } else {
            "Kaydırmalı yakalama bu sürümde yalnız macOS'ta kullanılabilir."
        });
        crate::windows::toast::show(app, &msg, "warning");
        return;
    }
    // macOS: `SCRecordingOutput` 15 ister; 12.3–14.x'te bölge seçtirip sonra hata
    // vermek yerine baştan söyle. Windows: WGC yoksa (10 1903 öncesi) aynı kapı.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if mode == "video" && !recorder::is_supported() {
        let store = &app.state::<AppState>().store;
        let msg = crate::i18n::t(store, "Video kaydı macOS 15 veya üzeri gerektirir.");
        crate::windows::toast::show(app, &msg, "warning");
        return;
    }

    {
        let state = app.state::<AppState>();
        let mut rt = state.runtime.lock().unwrap();
        if rt.is_capturing {
            drop(rt);
            crate::windows::toast::show(app, "İşlem devam ediyor...", "warning");
            return;
        }
        rt.is_capturing = true;
        rt.last_mode = mode.to_string();
    }
    *CAPTURE_T0.lock().unwrap() = Some(std::time::Instant::now());

    let monitors = geom::all_monitors(app);
    if monitors.is_empty() {
        finish(app);
        crate::windows::toast::show(app, "Ekran kaynakları alınamadı", "error");
        return;
    }
    let multi = monitors.len() > 1;
    if multi {
        let desc: Vec<String> = monitors
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let (x, y, w, h) = geom::physical_rect(m);
                format!("{i}: ({x},{y}) {w}x{h} ×{:.2} {}", m.scale, m.name.as_deref().unwrap_or("?"))
            })
            .collect();
        log::info!("çok monitör yakalama: {}", desc.join(" | "));
    }

    // Yakalama sırasında widget yakalanan görüntüye girmemeli.
    crate::windows::hide_if_open(app, "widget");

    // Overlay'leri ÖNCE aç — yükleme yakalamalarla paralel yürüsün.
    let mut labels = Vec::new();
    for (i, m) in monitors.iter().enumerate() {
        match crate::windows::capture::create(app, mode, i, m) {
            Ok(w) => {
                // Electron oturumu pencerenin `closed` olayından bitiriyordu — yani
                // pencere NASIL kapanırsa kapansın. Portta yalnız `close_all` bitiriyordu;
                // webview çökerse ya da pencere başka yoldan yok olursa `is_capturing`
                // takılı kalıp yakalamayı KALICI olarak engelliyordu ("İşlem devam
                // ediyor...") ve widget geri gelmiyordu.
                let h = app.clone();
                let closing_label = w.label().to_string();
                w.on_window_event(move |ev| {
                    if matches!(ev, tauri::WindowEvent::Destroyed) {
                        // El sıkışma durumunu bırak — bir sonraki yakalama aynı
                        // etiketle taze bir pencere açıyor.
                        forget_window(&h, &closing_label);
                        // Son overlay gidince oturumu bitir; diğerleri hâlâ açıksa
                        // bekle (Electron da her monitörün overlay'i gidene dek bekliyordu).
                        let remaining = h
                            .webview_windows()
                            .keys()
                            .filter(|l| l.starts_with(crate::windows::capture::PREFIX))
                            .count();
                        if remaining == 0 {
                            finish(&h);
                        }
                    }
                });
                labels.push(w.label().to_string())
            }
            Err(e) => {
                log::error!("yakalama overlay'i kurulamadı ({i}): {e}");
                labels.push(String::new());
            }
        }
    }

    let quality = app.state::<AppState>().settings().video_quality();
    let handle = app.clone();
    let mode_owned = mode.to_string();
    let monitors_owned = monitors.clone();

    // Yakalama arka planda: ana thread pencereleri çizmeye devam etsin.
    std::thread::spawn(move || {
        let mut any = false;
        for chunk_start in (0..monitors_owned.len()).step_by(CONCURRENCY) {
            let end = (chunk_start + CONCURRENCY).min(monitors_owned.len());
            let batch: Vec<_> = (chunk_start..end).collect();

            let results: Vec<_> = std::thread::scope(|s| {
                let handles: Vec<_> = batch
                    .iter()
                    .map(|&i| {
                        let m = monitors_owned[i].clone();
                        s.spawn(move || (i, screenshot::capture_monitor(&m, i)))
                    })
                    .collect();
                handles.into_iter().filter_map(|h| h.join().ok()).collect()
            });

            for (i, frame) in results {
                let Some(label) = labels.get(i).filter(|l| !l.is_empty()) else { continue };
                match frame {
                    Some(f) => {
                        any = true;
                        deliver(&handle, label, f, &mode_owned, &quality, multi);
                    }
                    None => crate::windows::close_if_open(&handle, label),
                }
            }
        }

        if !any {
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                close_all(&h, None);
                crate::windows::toast::show(&h, "Ekran görüntüsü alınamadı. Lütfen tekrar deneyin.", "error");
            });
        }
    });
}

/// Kareyi sakla ve pencereye "hazır" de.
///
/// ## Yükleme yarışı
///
/// Overlay pencereleri yakalamayla PARALEL açılıyor (yukarıdaki "overlay'ler ÖNCE"
/// notu) — yani bu fonksiyon çağrıldığında pencerenin sayfası henüz yüklenmemiş,
/// `listen('capture-screen')` promise'i çözülmemiş olabilir. O durumda olay hiçbir
/// yere gitmez ve overlay donuk bir karartmadan ibaret kalır: kullanıcı seçim yapar,
/// hiçbir şey olmaz.
///
/// Electron'da bu yarış YOKTU: `webContents.send` ancak `did-finish-load`dan sonra
/// çağrılıyordu. Buradaki karşılığı genel `window_ready` el sıkışması — hazır
/// olmayan overlay'in metadatası bekletilip [`window_ready`] geldiğinde teslim
/// ediliyor. Kare zaten saklandığı için gecikmenin bir bedeli yok.
///
/// Pratikte yakalama (~30 ms) sayfa yüklemesinden (~100 ms) hızlı bitiyor, yani bu
/// yol NORMALDE devreye giriyor — ölçüldüğünde marj ~100 ms'ydi, yani makine
/// yüklüyken ters dönebilecek kadar dar.
fn deliver(
    app: &tauri::AppHandle,
    label: &str,
    frame: screenshot::Frame,
    mode: &str,
    quality: &str,
    multi: bool,
) {
    let meta = CaptureMeta {
        mode: mode.to_string(),
        source_id: label.to_string(),
        quality: quality.to_string(),
        width: frame.width,
        height: frame.height,
        multi_monitor: multi,
    };
    log::debug!("kare teslim: {label} {}x{} ({} bayt PNG)", frame.width, frame.height, frame.png.len());
    if let Some(ms) = elapsed_since_begin_ms() {
        log::info!("PERF kare teslim {label} +{ms} ms");
    }
    let state = app.state::<CaptureState>();
    state.frames.lock().unwrap().insert(label.to_string(), frame);

    if state.ready.lock().unwrap().contains(label) {
        crate::windows::emit_to(app, label, "capture-screen", meta);
    } else {
        state.pending.lock().unwrap().insert(label.to_string(), meta);
    }
}

/// Bir overlay renderer'ı dinleyicilerini kurdu. Kare hazırsa şimdi teslim edilir.
pub fn window_ready(app: &tauri::AppHandle, label: &str) {
    let pending = {
        let state = app.state::<CaptureState>();
        state.ready.lock().unwrap().insert(label.to_string());
        let taken = state.pending.lock().unwrap().remove(label);
        taken
    };
    if let Some(meta) = pending {
        log::debug!("{label}: kare bekliyordu, dinleyici kuruldu — şimdi teslim ediliyor");
        crate::windows::emit_to(app, label, "capture-screen", meta);
    }
}

/// Overlay kapandı — el sıkışma durumunu temizle ki sonraki yakalama taze başlasın.
pub fn forget_window(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<CaptureState>();
    state.ready.lock().unwrap().remove(label);
    state.pending.lock().unwrap().remove(label);
}

#[cfg(target_os = "macos")]
fn request_screen_permission(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let handle = app.clone();
    app.dialog()
        .message(
            "CopyBoard ekran görüntüsü alabilmek için \"Ekran Kaydı\" iznine ihtiyaç duyar.\n\n\
             Sistem Ayarları > Gizlilik ve Güvenlik > Ekran Kaydı bölümünden uygulamaya izin verin.",
        )
        .title("Ekran Kaydı İzni Gerekli")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Ayarları Aç".into(), "İptal".into()))
        .show(move |open_settings| {
            if !open_settings {
                return;
            }
            // Sistemin kendi istem akışını da tetikle: kullanıcı listeye eklenmemişse
            // Ayarlar'ı açmak tek başına yetmiyor.
            crate::platform::macos::permissions::request_screen_recording();
            use tauri_plugin_opener::OpenerExt;
            let _ = handle.opener().open_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                None::<&str>,
            );
        });
}

/// Renderer'ın kareyi çektiği yer. Ham PNG baytları döner (JSON DEĞİL).
#[tauri::command]
pub fn take_capture_frame(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, CaptureState>,
) -> tauri::ipc::Response {
    let frames = state.frames.lock().unwrap();
    let png = frames.get(window.label()).map(|f| f.png.clone()).unwrap_or_default();
    log::debug!(
        "kare çekildi: {} → {} bayt (önbellekteki etiketler: {:?})",
        window.label(), png.len(), frames.keys().collect::<Vec<_>>()
    );
    drop(frames);
    tauri::ipc::Response::new(png)
}

/// Overlay kullanılamaz bir görüntü aldı (boş, ya da çözülemeyen bir PNG).
/// Hata göstermek yerine kendini onarıyor: o monitörü yeniden yakalayıp gönderiyor.
/// Overlay yalnız kullanılabilir bir görüntü geldikten sonra görünür olduğu için
/// yeniden denemeler kullanıcıya görünmüyor.
#[tauri::command]
pub async fn capture_retry(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    let label = window.label().to_string();
    let count = {
        let state = app.state::<CaptureState>();
        let mut retries = state.retries.lock().unwrap();
        let c = retries.entry(label.clone()).or_insert(0);
        *c += 1;
        *c
    };
    if count > MAX_RETRIES {
        close_all(&app, None);
        crate::windows::toast::show(&app, "Ekran görüntüsü alınamadı. Lütfen tekrar deneyin.", "error");
        return;
    }

    let Some(index) = label.rsplit('-').next().and_then(|s| s.parse::<usize>().ok()) else { return };
    let monitors = geom::all_monitors(&app);
    let Some(m) = monitors.get(index).cloned() else { return };
    let multi = monitors.len() > 1;
    let state = app.state::<AppState>();
    let mode = state.runtime.lock().unwrap().last_mode.clone();
    let quality = state.settings().video_quality();

    // Yeniden yakalamada overlay'in KENDİSİ görüntüye girmemeli.
    let _ = window.hide();

    let handle = app.clone();
    std::thread::spawn(move || match screenshot::capture_monitor(&m, index) {
        Some(frame) => deliver(&handle, &label, frame, &mode, &quality, multi),
        None => {
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                close_all(&h, None);
                crate::windows::toast::show(&h, "Ekran görüntüsü alınamadı. Lütfen tekrar deneyin.", "error");
            });
        }
    });
}

/// Overlay kullanılabilir bir görüntü aldı → göster.
#[tauri::command]
pub async fn snip_ready(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    // Karışık DPI güvencesi + tanı: gösterim sırasında gelen DPI değişimi pencereyi
    // yeniden boyutlandırmış olabilir; hedef dikdörtgeni yeniden uygula ve gerçekleşen
    // konum/boyutu günlüğe yaz (çok monitörde "seçim yapılamıyor" raporları için).
    let app = window.app_handle().clone();
    let target = app.state::<CaptureState>().overlays.lock().unwrap().get(window.label()).cloned();
    if let Some(m) = target {
        if let Err(e) = geom::place_on_monitor(&window, &m) {
            log::warn!("{}: yeniden yerleştirme başarısız: {e}", window.label());
        }
        let (x, y, w, h) = geom::physical_rect(&m);
        let got_pos = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((i32::MIN, i32::MIN));
        let got_size = window.inner_size().map(|s| (s.width, s.height)).unwrap_or((0, 0));
        log::info!(
            "overlay {}: hedef fiziksel ({x},{y}) {w}x{h} ×{:.2} → gerçek konum {:?} boyut {:?}",
            window.label(), m.scale, got_pos, got_size
        );
    }
}

/// Bir monitörde yeni seçim başladı → DİĞER monitörlere seçimlerini temizlemelerini
/// söyle. Overlay'ler açık, karanlık VE etkileşimli kalıyor, böylece yalnız en son
/// seçim var oluyor ve kullanıcı serbestçe başka monitörde yeniden seçebiliyor.
#[tauri::command]
pub async fn capture_claim_monitor(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    for (label, w) in app.webview_windows() {
        if label.starts_with(crate::windows::capture::PREFIX) && label != window.label() {
            let _ = w.emit_to(&label, "capture-reset", ());
        }
    }
}

#[tauri::command]
pub async fn snip_close(app: tauri::AppHandle) {
    close_all(&app, None);
}

/// Her monitörün overlay'ini kapatır. `keep` verilirse o pencere hayatta kalır —
/// video kaydı bir monitörde başladığında diğerlerinin gitmesi gerekiyor.
pub fn close_all(app: &tauri::AppHandle, keep: Option<&str>) {
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with(crate::windows::capture::PREFIX))
        .cloned()
        .collect();
    for label in labels {
        if Some(label.as_str()) == keep {
            continue;
        }
        crate::windows::close_if_open(app, &label);
    }
    finish(app);
}

/// Bir pencere HARİÇ diğer overlay'leri kapatır — video/kaydırma tek monitörde
/// sürerken diğerlerinin gitmesi gerekiyor. Oturumu BİTİRMEZ.
pub fn close_all_except(app: &tauri::AppHandle, keep: &str) {
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with(crate::windows::capture::PREFIX) && l.as_str() != keep)
        .cloned()
        .collect();
    for label in labels {
        crate::windows::close_if_open(app, &label);
    }
}

/// Yakalama oturumu bitti: bayrağı düşür, widget'ı geri getir, kare önbelleğini boşalt,
/// ve canlı kalmış her akışı/kısayolu bırak.
///
/// Electron'da kaydırma evresinin global Escape'i pencerenin `closed` olayına da
/// bağlıydı — dosyanın kendi yorumu şart koşuyordu: "evreden çıkan HER yol — bitiş,
/// iptal, pencere kapandı, çıkış — onu bırakır". Akış artık Rust tarafında yaşadığı
/// için pencerenin kapanması onu KENDİLİĞİNDEN durdurmuyor; teardown buraya taşındı.
/// Overlay hangi monitörü kaplıyor — `snip_ready` yeniden yerleştirme ve tanı için.
pub fn remember_overlay(app: &tauri::AppHandle, label: &str, m: &geom::MonitorInfo) {
    app.state::<CaptureState>().overlays.lock().unwrap().insert(label.to_string(), m.clone());
}

pub fn finish(app: &tauri::AppHandle) {
    // Kaydırma akışı + onun global Escape'i
    crate::commands::record::teardown_streams(app);
    {
        let state = app.state::<AppState>();
        state.runtime.lock().unwrap().is_capturing = false;
    }
    let cs = app.state::<CaptureState>();
    cs.frames.lock().unwrap().clear();
    cs.retries.lock().unwrap().clear();
    cs.overlays.lock().unwrap().clear();
    // Kaydetme paneli overlay'le birlikte gittiyse kilidi de bırak.
    crate::commands::capture::reset_save_guard();

    if app.state::<AppState>().settings().show_widget() {
        // Odak ÇALMADAN geri getir: kullanıcı yakalamadan sonra yazdığı yere dönüyor.
        crate::windows::widget::show_inactive(app);
    }
}

use tauri::Emitter;
