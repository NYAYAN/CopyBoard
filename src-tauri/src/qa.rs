//! `--qa`: hata ayıklama derlemesine özgü kendini-sınama.
//!
//! Rust tarafındaki kullanıcı akışlarını (kopyalama, favori, widget aç/kapa, hızlı
//! yapıştır, görüntüleyici, yakalama overlay'i, toast, tema) renderer'a hiç uğramadan
//! komut işleyicileri üzerinden sırayla çalıştırır ve her adımın SONUCUNU pencere/pano
//! durumundan okuyarak günlüğe yazar: `QA ✓ …` / `QA ✗ …`.
//!
//! Neden var: "kopyalandı diyor ama kopyalanmadı", "widget kapat/aç sonrası gelmiyor",
//! "büyük görüntüle çalışmıyor" gibi raporlarda hatanın renderer'da mı, komutta mı,
//! pencere katmanında mı olduğunu tek çalıştırmada ayırt etmek. Arayüz tıklamaları
//! ayrıca sınanır; bu harness tıklamanın ULAŞTIĞI yerin sağlam olduğunu kanıtlar.
//!
//! Yalnız `debug_assertions` altında derlenir; paketli sürümde yoktur.

#![cfg(debug_assertions)]

use std::sync::mpsc;
use std::time::Duration;

use tauri::Manager;

use crate::state::AppState;

/// Adımı ana thread'de çalıştırır ve dönmesini bekler.
fn on_main<T: Send + 'static>(app: &tauri::AppHandle, f: impl FnOnce(&tauri::AppHandle) -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    let h = app.clone();
    if app.run_on_main_thread(move || { let _ = tx.send(f(&h)); }).is_err() {
        return None;
    }
    rx.recv_timeout(Duration::from_secs(5)).ok()
}

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn visible(app: &tauri::AppHandle, label: &str) -> Option<bool> {
    app.get_webview_window(label).map(|w| w.is_visible().unwrap_or(false))
}

fn report(ok: bool, what: &str) {
    if ok { log::info!("QA ✓ {what}") } else { log::error!("QA ✗ {what}") }
}

pub fn run(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("copyboard-qa".into())
        .spawn(move || {
            sleep(2500); // açılış otursun
            log::info!("QA başlıyor");
            let mut fails = 0usize;
            let mut check = |ok: bool, what: &str| { if !ok { fails += 1; } report(ok, what); };

            // ── 1. Kopyalama: copy_text panoya gerçekten yazıyor mu ──────────
            let probe = format!("QA-{}", std::process::id());
            let p = probe.clone();
            let after = on_main(&app, move |h| {
                crate::commands::clipboard::write_and_record(h, &p);
                crate::platform::clipboard_read_text()
            }).flatten();
            check(after.as_deref() == Some(probe.as_str()), &format!("copy_text panoya yazdı (okunan: {after:?})"));
            sleep(1500);
            let later = crate::platform::clipboard_read_text();
            check(later.as_deref() == Some(probe.as_str()), &format!("pano 1,5 sn sonra hâlâ aynı (okunan: {later:?})"));
            let in_hist = {
                let st = app.state::<AppState>();
                crate::clipboard::history::history(&st.store).iter()
                    .any(|i| i.get("content").and_then(|c| c.as_str()) == Some(probe.as_str()))
            };
            check(in_hist, "kopya geçmişe eklendi");

            // ── 2. Favori ekle / kaldır ───────────────────────────────────────
            let fav = serde_json::json!({ "content": format!("{probe}-fav"), "note": "qa" });
            let f2 = fav.clone();
            on_main(&app, move |h| crate::clipboard::history::add_favorite(h, &f2));
            let fav_id = {
                let st = app.state::<AppState>();
                crate::clipboard::history::favorites(&st.store).iter()
                    .find(|f| f.get("content") == fav.get("content"))
                    .and_then(|f| f.get("id").and_then(|i| i.as_str()).map(str::to_string))
            };
            check(fav_id.is_some(), "favori eklendi");
            if let Some(id) = fav_id {
                let id2 = id.clone();
                on_main(&app, move |h| crate::clipboard::history::remove_favorite(h, &id2));
                let gone = {
                    let st = app.state::<AppState>();
                    !crate::clipboard::history::favorites(&st.store).iter()
                        .any(|f| f.get("id").and_then(|i| i.as_str()) == Some(id.as_str()))
                };
                check(gone, "favori kaldırıldı");
            }
            // Deneme kaydını geçmişten de temizle.
            {
                let ids: Vec<String> = {
                    let st = app.state::<AppState>();
                    crate::clipboard::history::history(&st.store).iter()
                        .filter(|i| i.get("content").and_then(|c| c.as_str()) == Some(probe.as_str()))
                        .filter_map(|i| i.get("id").and_then(|v| v.as_str()).map(str::to_string)).collect()
                };
                for id in ids { on_main(&app, move |h| crate::clipboard::history::delete(h, &id)); }
            }

            // ── 3. Ana pencere göster / gizle ─────────────────────────────────
            on_main(&app, |h| crate::windows::main_window::show(h));
            sleep(400);
            check(visible(&app, "main") == Some(true), "ana pencere show() sonrası görünür");
            on_main(&app, |h| crate::windows::main_window::hide(h));
            sleep(300);
            check(visible(&app, "main") == Some(false), "ana pencere hide() sonrası gizli");

            // ── 4. Widget kapat / aç ──────────────────────────────────────────
            on_main(&app, |h| crate::windows::widget::toggle(h, false));
            sleep(800);
            check(app.get_webview_window("widget").is_none(), "widget kapatıldı (pencere yok)");
            on_main(&app, |h| crate::windows::widget::toggle(h, true));
            sleep(1500);
            check(visible(&app, "widget") == Some(true), "widget yeniden açıldı ve görünür");
            sleep(1200); // hit-test bir geçirgenlik değişimi yapsın
            check(visible(&app, "widget") == Some(true), "widget hit-test geçişinden sonra hâlâ görünür");

            // ── 5. Hızlı yapıştır aç / kapa ───────────────────────────────────
            on_main(&app, |h| crate::windows::quickpaste::toggle(h));
            sleep(600);
            check(visible(&app, "quickpaste") == Some(true), "hızlı yapıştır açıldı");
            on_main(&app, |h| crate::windows::quickpaste::toggle(h));
            sleep(300);
            check(visible(&app, "quickpaste") == Some(false), "hızlı yapıştır kapandı");

            // ── 6. Toast ──────────────────────────────────────────────────────
            on_main(&app, |h| crate::windows::toast::show(h, "QA toast", "info"));
            sleep(900);
            check(visible(&app, "toast") == Some(true), "toast görünür");

            // ── 7. Görüntüleyici ─────────────────────────────────────────────
            let first = {
                let st = app.state::<AppState>();
                crate::gallery::public_list(&st.store).first()
                    .and_then(|s| s.get("id").and_then(|i| i.as_str()).map(str::to_string))
            };
            match first {
                None => log::warn!("QA – galeri boş, görüntüleyici adımları atlandı"),
                Some(id) => {
                    let id2 = id.clone();
                    on_main(&app, move |h| crate::commands::viewer::open(h, &id2));
                    sleep(1200);
                    check(visible(&app, "viewer") == Some(true), "görüntüleyici açıldı ve görünür");
                    on_main(&app, |h| crate::commands::viewer::minimize(h));
                    sleep(700);
                    let min = app.get_webview_window("viewer").and_then(|w| w.is_minimized().ok());
                    check(min == Some(true), &format!("görüntüleyici küçültüldü (is_minimized={min:?})"));
                    on_main(&app, |h| { if let Some(w) = h.get_webview_window("viewer") { let _ = w.unminimize(); } });
                    sleep(500);
                    on_main(&app, |h| crate::commands::viewer::toggle_maximize(h));
                    sleep(700);
                    let max = app.get_webview_window("viewer").and_then(|w| w.is_maximized().ok());
                    check(max == Some(true), &format!("görüntüleyici büyütüldü (is_maximized={max:?})"));
                    on_main(&app, |h| crate::commands::viewer::toggle_maximize(h));
                    sleep(500);
                    on_main(&app, |h| crate::commands::viewer::nav(h, "next"));
                    sleep(300);
                    on_main(&app, |h| crate::commands::viewer::close(h));
                    sleep(800);
                    check(app.get_webview_window("viewer").is_none(), "görüntüleyici kapandı (pencere yok)");
                }
            }

            // ── 8. Yakalama overlay'i (draw) ──────────────────────────────────
            on_main(&app, |h| crate::capture::start(h, "draw"));
            sleep(2500);
            let overlays: Vec<String> = app.webview_windows().keys().filter(|l| l.starts_with("capture-")).cloned().collect();
            check(!overlays.is_empty(), &format!("yakalama overlay'i kuruldu ({overlays:?})"));
            let any_visible = overlays.iter().any(|l| visible(&app, l) == Some(true));
            check(any_visible, "en az bir overlay görünür (kare teslim edildi, snip_ready geldi)");
            on_main(&app, |h| crate::capture::close_all(h, None));
            sleep(800);
            let left = app.webview_windows().keys().filter(|l| l.starts_with("capture-")).count();
            check(left == 0, "overlay'ler kapandı");
            check(visible(&app, "widget") == Some(true), "yakalama sonrası widget geri geldi");
            let capturing = app.state::<AppState>().runtime.lock().unwrap().is_capturing;
            check(!capturing, "is_capturing bayrağı düştü");

            // ── 9. Video kaydı ve kaydırma akışı (motor düzeyinde) ────────────
            // Overlay/renderer'a uğramadan: kaydediciyi doğrudan başlat, ekranı
            // değiştir (WGC yalnız değişimde kare verir), durdur, dosyayı ölç.
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                let monitors = crate::geom::all_monitors(&app);
                match monitors.first().cloned() {
                    None => log::warn!("QA – monitör yok, kayıt adımları atlandı"),
                    Some(m) => {
                        let path = std::env::temp_dir().join("copyboard-qa-record.mp4");
                        // Ses de açık: mikrofon + sistem sesi (WASAPI). Aygıt yoksa kayıt
                        // sessiz sürer ve log'a "ses açılamadı" düşer; adım yine geçer.
                        let started = crate::capture::recorder::start(
                            &m, 100.0, 100.0, 640.0, 360.0, "high", true, true, "qa".into(), path.clone(),
                        );
                        match started {
                            Err(e) => check(false, &format!("video kaydı başlatılamadı: {e}")),
                            Ok(mut rec) => {
                                check(true, "video kaydı başladı");
                                // Ekranda hareket üret: ana pencereyi birkaç kez göster/gizle.
                                for _ in 0..4 {
                                    on_main(&app, |h| crate::windows::main_window::show(h));
                                    sleep(350);
                                    on_main(&app, |h| crate::windows::main_window::hide(h));
                                    sleep(350);
                                }
                                match rec.stop() {
                                    Ok(p) => {
                                        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                                        check(size > 10_000, &format!("video dosyası yazıldı ({:.1} KB) → {}", size as f64 / 1024.0, p.display()));
                                    }
                                    Err(e) => check(false, &format!("video kaydı durdurulamadı: {e}")),
                                }
                            }
                        }

                        // Kaydırma akışı: Channel'a düşen kare sayısı.
                        let count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
                        let c2 = count.clone();
                        let channel = tauri::ipc::Channel::<tauri::ipc::InvokeResponseBody>::new(move |body| {
                            if let tauri::ipc::InvokeResponseBody::Raw(b) = body {
                                if b.len() > 12 { c2.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
                            }
                            Ok(())
                        });
                        match crate::capture::scroll_stream::start(&m, 100.0, 100.0, 400.0, 300.0, 15, Some("CopyBoard"), channel) {
                            Err(e) => check(false, &format!("kaydırma akışı başlatılamadı: {e}")),
                            Ok(mut s) => {
                                for _ in 0..3 {
                                    on_main(&app, |h| crate::windows::main_window::show(h));
                                    sleep(300);
                                    on_main(&app, |h| crate::windows::main_window::hide(h));
                                    sleep(300);
                                }
                                s.stop();
                                let n = count.load(std::sync::atomic::Ordering::Relaxed);
                                check(n > 0, &format!("kaydırma akışı kare verdi ({n} kare)"));
                            }
                        }
                    }
                }
            }

            // ── 9b. Renderer → IPC → komut (gerçek yol) ───────────────────────
            // Ana pencerenin sayfasında `window.api.copyText` çalıştırılıyor: invoke
            // gerçekten Rust'a ulaşıyor ve pano değişiyor mu? Tıklama olmadan, sayfa
            // içinden aynı yol.
            let ipc_probe = format!("QA-IPC-{}", std::process::id());
            let script = format!("window.api.copyText({});", serde_json::json!(ipc_probe));
            let evaluated = on_main(&app, move |h| {
                h.get_webview_window("main").map(|w| w.eval(&script).is_ok()).unwrap_or(false)
            }).unwrap_or(false);
            check(evaluated, "ana pencerede eval çalıştı");
            sleep(1200);
            let got = crate::platform::clipboard_read_text();
            check(got.as_deref() == Some(ipc_probe.as_str()), &format!("renderer → IPC → copy_text panoyu değiştirdi (okunan: {got:?})"));
            // Deneme kaydını temizle.
            {
                let ids: Vec<String> = {
                    let st = app.state::<AppState>();
                    crate::clipboard::history::history(&st.store).iter()
                        .filter(|i| i.get("content").and_then(|c| c.as_str()) == Some(ipc_probe.as_str()))
                        .filter_map(|i| i.get("id").and_then(|v| v.as_str()).map(str::to_string)).collect()
                };
                for id in ids { on_main(&app, move |h| crate::clipboard::history::delete(h, &id)); }
            }

            // ── 9c. Güncelleyici: pubkey boşken elle kontrol uyarı toast'ı vermeli ──
            {
                let configured = crate::updater::is_configured(&app);
                tauri::async_runtime::block_on(crate::updater::check_manual(app.clone()));
                sleep(900);
                let toast_up = visible(&app, "toast") == Some(true);
                check(toast_up, &format!("güncelleyici elle kontrol yanıt verdi (pubkey {}, toast görünür)", if configured { "dolu" } else { "boş" }));
            }

            // ── 10. Tema ──────────────────────────────────────────────────────
            let os_dark = crate::platform::os_prefers_dark_hint();
            log::info!("QA · OS koyu tema ipucu: {os_dark:?}");
            check(os_dark.is_some(), "OS tema tercihi okunabildi");

            log::info!("QA bitti: {} başarısız adım", fails);
        })
        .expect("qa thread");
}
