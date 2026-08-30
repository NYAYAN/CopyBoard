// S1 / S2 / S7 spike — CopyBoard'un 9 pencere tipinin bayrakları Tauri v2'de kurulabiliyor mu?
//
// S1: frameless + transparent + vibrancy + screen-saver seviyesi + allWorkspaces
//     + contentProtected + ignoreCursorEvents + skipTaskbar + shadow(false)
// S2: focusable(false) penceresi macOS'ta odağı ÇALMIYOR mu? (Hızlı Yapıştır'ın kalbi)
// S7: initialization_script sayfa scriptlerinden ÖNCE mi çalışıyor? (tema titremesi)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// Probe sayfalarının kendi ölçümlerini geri yolladığı yer (S7 + render yetenekleri).
#[derive(Default)]
struct Reports(Mutex<Vec<ProbeSelfReport>>);

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ProbeSelfReport {
    kind: String,
    #[serde(rename = "bootPresent")]
    boot_present: bool,
    #[serde(rename = "bootAt")]
    boot_at: f64,
    #[serde(rename = "firstScriptAt")]
    first_script_at: f64,
    dpr: f64,
    #[serde(rename = "backdropFilter")]
    backdrop_filter: bool,
    #[serde(rename = "dictOk")]
    dict_ok: bool,
}

#[derive(Serialize, Clone)]
struct ProbeReport {
    label: String,
    built: bool,
    notes: Vec<String>,
}

// ── BULGU (S1-a) ─────────────────────────────────────────────────────────────
// AppKit'in NSWindow API'lerinin TAMAMI yalnız ana thread'den çağrılabilir.
// Tauri komutları (async ve sync) async runtime'ın worker thread'inde koşar, bu
// yüzden doğrudan objc çağrısı süreci SIGTRAP ile öldürür:
//     asi: libsystem_c.dylib "Must only be used from the main thread"
//     AppKit -[NSWindow _applyWindowLevelWithTagUpdateNeeded:]
// Çözüm: her AppKit dokunuşu run_on_main_thread içinden. Sonucu geri almak için
// tek seferlik kanal. Bu kural gerçek uygulamada platform/macos/* modüllerinin
// TAMAMI için geçerlidir — vibrancy, level, collectionBehavior, activate, hepsi.
fn on_main<F, T>(win: &tauri::WebviewWindow, f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    win.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("run_on_main_thread: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| format!("ana thread yanıt vermedi: {e}"))
}

// --- macOS: NSWindow.level ---------------------------------------------------
// Electron 'screen-saver' (1000) ve 'pop-up-menu' (101) seviyelerinin karşılığı.
// Tauri'nin set_always_on_top'u yalnız NSFloatingWindowLevel (3) verir.
#[cfg(target_os = "macos")]
fn set_ns_level(win: &tauri::WebviewWindow, level: isize) -> Result<(), String> {
    let w = win.clone();
    on_main(win, move || -> Result<(), String> {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWindow;
        let ptr = w.ns_window().map_err(|e| e.to_string())?;
        if ptr.is_null() {
            return Err("ns_window() null döndü".into());
        }
        unsafe {
            let ns: Retained<NSWindow> =
                Retained::retain(ptr.cast()).ok_or("retain başarısız")?;
            ns.setLevel(level);
        }
        Ok(())
    })?
}

#[cfg(not(target_os = "macos"))]
fn set_ns_level(_win: &tauri::WebviewWindow, _level: isize) -> Result<(), String> {
    Err("yalnızca macOS".into())
}

// --- macOS: collectionBehavior ----------------------------------------------
// setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) karşılığı.
// Tauri'nin visible_on_all_workspaces'i fullScreenAuxiliary bayrağını set etmiyor
// (tauri#11488) — overlay'in tam ekran uygulamaların üstünde durması buna bağlı.
#[cfg(target_os = "macos")]
fn set_join_all_spaces(win: &tauri::WebviewWindow) -> Result<(), String> {
    let w = win.clone();
    on_main(win, move || -> Result<(), String> {
        use objc2::rc::Retained;
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let ptr = w.ns_window().map_err(|e| e.to_string())?;
        if ptr.is_null() {
            return Err("ns_window() null döndü".into());
        }
        unsafe {
            let ns: Retained<NSWindow> =
                Retained::retain(ptr.cast()).ok_or("retain başarısız")?;
            ns.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
        }
        Ok(())
    })?
}

#[cfg(not(target_os = "macos"))]
fn set_join_all_spaces(_win: &tauri::WebviewWindow) -> Result<(), String> {
    Err("yalnızca macOS".into())
}

// Vibrancy de AppKit'e dokunur → aynı kural.
#[cfg(target_os = "macos")]
fn apply_vibrancy_main(win: &tauri::WebviewWindow) -> Result<(), String> {
    let w = win.clone();
    on_main(win, move || -> Result<(), String> {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        apply_vibrancy(
            &w,
            NSVisualEffectMaterial::UnderWindowBackground,
            Some(NSVisualEffectState::Active),
            None,
        )
        .map_err(|e| e.to_string())
    })?
}

// S7: gerçek uygulamada sözlük + tema burada enjekte edilecek.
fn boot_script(kind: &str) -> String {
    let boot = serde_json::json!({
        "platform": if cfg!(target_os = "macos") { "darwin" }
                    else if cfg!(target_os = "windows") { "win32" } else { "linux" },
        "kind": kind,
        "i18n":  { "lang": "tr", "dict": { "Kaydet": "Save" } },
        "theme": { "mode": "dark", "resolved": "dark" },
        "injectedAt": "initialization_script"
    });
    format!(
        "window.__COPYBOARD_BOOT__ = {}; window.__BOOT_SEEN_AT__ = performance.now();",
        boot
    )
}

#[tauri::command]
async fn spawn_probe(app: tauri::AppHandle, kind: String) -> Result<ProbeReport, String> {
    let label = format!("probe-{kind}");
    let mut notes: Vec<String> = Vec::new();

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
        std::thread::sleep(std::time::Duration::from_millis(120));
    }

    let mut b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("probe.html".into()))
        .initialization_script(boot_script(&kind))
        .decorations(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false);

    // CopyBoard'un gerçek pencere tipleri
    b = match kind.as_str() {
        // Ana pencere: 350x550, macOS'ta transparent + vibrancy, screen-saver seviyesi
        "main" => b.inner_size(350.0, 550.0).position(80.0, 80.0).transparent(cfg!(target_os = "macos")),
        // Widget: 418x68, her zaman şeffaf, gölgesiz
        "widget" => b.inner_size(418.0, 68.0).position(520.0, 80.0).transparent(true).always_on_top(true),
        // Hızlı Yapıştır: 300x380, ODAK ÇALMAMALI  ← S2
        "quickpaste" => b.inner_size(300.0, 380.0).position(80.0, 660.0).transparent(true).focusable(false).always_on_top(true),
        // Toast: 320x100, tıklama geçirgen, odak çalmaz
        "toast" => b.inner_size(320.0, 100.0).position(520.0, 660.0).transparent(true).focusable(false).always_on_top(true),
        // Capture overlay: tam monitör, contentProtected, pop-up-menu seviyesi
        "capture" => {
            let m = app.primary_monitor().ok().flatten();
            let (w, h, x, y) = match &m {
                Some(mon) => {
                    let sf = mon.scale_factor();
                    let sz = mon.size().to_logical::<f64>(sf);
                    let ps = mon.position().to_logical::<f64>(sf);
                    (sz.width, sz.height, ps.x, ps.y)
                }
                None => (1280.0, 800.0, 0.0, 0.0),
            };
            notes.push(format!("monitör mantıksal: {w}x{h} @ {x},{y}"));
            b.inner_size(w, h).position(x, y).transparent(true).always_on_top(true).content_protected(true)
        }
        // Görüntüleyici: çerçevesiz ama boyutlandırılabilir + maximize
        "viewer" => b.inner_size(900.0, 620.0).position(200.0, 200.0).resizable(true).maximizable(true).minimizable(true).shadow(true),
        other => return Err(format!("bilinmeyen tip: {other}")),
    };

    let win = b.build().map_err(|e| format!("build() başarısız: {e}"))?;

    // --- Bayrak sonrası uygulamalar ---
    if kind == "main" {
        #[cfg(target_os = "macos")]
        match apply_vibrancy_main(&win) {
            Ok(_) => notes.push("vibrancy: UnderWindowBackground ✅".into()),
            Err(e) => notes.push(format!("vibrancy BAŞARISIZ: {e}")),
        }
    }

    // screen-saver (1000) / pop-up-menu (101) seviyeleri
    let want_level: Option<isize> = match kind.as_str() {
        "main" | "widget" | "toast" | "quickpaste" => Some(1000),
        "capture" => Some(101),
        _ => None,
    };
    if let Some(lvl) = want_level {
        match set_ns_level(&win, lvl) {
            Ok(_) => notes.push(format!("NSWindow.level = {lvl} ✅")),
            Err(e) => notes.push(format!("NSWindow.level BAŞARISIZ: {e}")),
        }
    }

    // allWorkspaces + fullScreenAuxiliary
    if matches!(kind.as_str(), "main" | "widget" | "toast" | "quickpaste" | "capture") {
        match win.set_visible_on_all_workspaces(true) {
            Ok(_) => notes.push("set_visible_on_all_workspaces ✅".into()),
            Err(e) => notes.push(format!("set_visible_on_all_workspaces BAŞARISIZ: {e}")),
        }
        match set_join_all_spaces(&win) {
            Ok(_) => notes.push("collectionBehavior: CanJoinAllSpaces|FullScreenAuxiliary ✅".into()),
            Err(e) => notes.push(format!("collectionBehavior BAŞARISIZ: {e}")),
        }
    }

    // Toast tıklama geçirgen
    if kind == "toast" {
        match win.set_ignore_cursor_events(true) {
            Ok(_) => notes.push("set_ignore_cursor_events(true) ✅".into()),
            Err(e) => notes.push(format!("set_ignore_cursor_events BAŞARISIZ: {e}")),
        }
    }

    // S2: show() odağı çalıyor mu? focusable(false) pencerelerde ÇALMAMALI.
    win.show().map_err(|e| e.to_string())?;
    notes.push("show() çağrıldı — focus() ÇAĞRILMADI".into());

    Ok(ProbeReport { label, built: true, notes })
}

#[tauri::command]
fn report_probe(reports: tauri::State<'_, Reports>, r: ProbeSelfReport) {
    reports.0.lock().unwrap().push(r);
}

#[tauri::command]
fn close_probe(app: tauri::AppHandle, kind: String) {
    if let Some(w) = app.get_webview_window(&format!("probe-{kind}")) {
        let _ = w.close();
    }
}

// S2 ölçümü: hangi pencere odakta? Probe açıldıktan sonra kontrol penceresi
// odağı KORUMALI (quickpaste/toast için).
#[tauri::command]
fn placement(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    app.webview_windows().iter().map(|(label, w)| {
        let sf = w.scale_factor().unwrap_or(1.0);
        let op = w.outer_position().ok();
        let os = w.outer_size().ok();
        serde_json::json!({
            "label": label,
            "visible": w.is_visible().unwrap_or(false),
            "minimized": w.is_minimized().unwrap_or(false),
            "scaleFactor": sf,
            "outerPositionPhysical": op.map(|p| serde_json::json!({"x":p.x,"y":p.y})),
            "outerPositionLogical": op.map(|p| { let l = p.to_logical::<f64>(sf); serde_json::json!({"x":l.x,"y":l.y}) }),
            "outerSizePhysical": os.map(|z| serde_json::json!({"w":z.width,"h":z.height})),
        })
    }).collect()
}

#[tauri::command]
fn focus_report(app: tauri::AppHandle) -> Vec<(String, bool, bool)> {
    app.webview_windows()
        .iter()
        .map(|(label, w)| {
            (
                label.clone(),
                w.is_focused().unwrap_or(false),
                w.is_visible().unwrap_or(false),
            )
        })
        .collect()
}

#[tauri::command]
fn monitors(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            let wa = m.work_area();
            serde_json::json!({
                "name": m.name().cloned().unwrap_or_default(),
                "scaleFactor": sf,
                "sizePhysical": { "w": m.size().width, "h": m.size().height },
                "sizeLogical": { "w": m.size().to_logical::<f64>(sf).width, "h": m.size().to_logical::<f64>(sf).height },
                "positionPhysical": { "x": m.position().x, "y": m.position().y },
                "workAreaPhysical": { "x": wa.position.x, "y": wa.position.y, "w": wa.size.width, "h": wa.size.height }
            })
        })
        .collect()
}

// ── Kendi kendini süren ölçüm ────────────────────────────────────────────────
// El ile tıklamaya gerek kalmadan altı pencere tipini kurar, odak davranışını
// ölçer, probe sayfalarının kendi raporlarını toplar ve JSON basar.
async fn auto_run(app: tauri::AppHandle) {
    use std::time::Duration;
    let sleep = |ms: u64| tokio_sleep(ms);

    sleep(900).await;

    // quickpaste EN SON: ondan önce odağın kimde olduğunu not edip, açıldıktan
    // sonra odağın YERİNDE kaldığını ölçüyoruz. S2'nin gerçek sorusu bu —
    // "yeni pencere kendine odak aldı mı" değil, "var olan odağı bozdu mu".
    let kinds = ["main", "widget", "toast", "capture", "viewer"];
    let mut build_results = serde_json::Map::new();

    for k in kinds {
        let r = spawn_probe(app.clone(), k.to_string()).await;
        match r {
            Ok(rep) => {
                build_results.insert(k.to_string(), serde_json::json!({
                    "built": true, "notes": rep.notes
                }));
            }
            Err(e) => {
                build_results.insert(k.to_string(), serde_json::json!({
                    "built": false, "error": e
                }));
            }
        }
        sleep(400).await;
    }

    // ── S2 ölçümü ────────────────────────────────────────────────────────────
    sleep(500).await;
    let owner_before: Option<String> = focus_report(app.clone())
        .into_iter().find(|(_, f, _)| *f).map(|(l, _, _)| l);

    let qp = spawn_probe(app.clone(), "quickpaste".to_string()).await;
    match qp {
        Ok(rep) => { build_results.insert("quickpaste".into(), serde_json::json!({"built": true, "notes": rep.notes})); }
        Err(e)  => { build_results.insert("quickpaste".into(), serde_json::json!({"built": false, "error": e})); }
    }

    sleep(700).await;
    let focus = focus_report(app.clone());
    let owner_after: Option<String> = focus.iter().find(|(_, f, _)| *f).map(|(l, _, _)| l.clone());
    let qp_focused = focus.iter().any(|(l, f, _)| l == "probe-quickpaste" && *f);
    let focus_unchanged = owner_before == owner_after;

    sleep(700).await; // probe sayfaları report_probe'u çağırsın
    let self_reports = app.state::<Reports>().0.lock().unwrap().clone();

    let s7_ok = self_reports.iter().all(|r| r.boot_present && r.dict_ok);

    let out = serde_json::json!({
        "spike": "S1/S2/S7",
        "platform": std::env::consts::OS,
        "monitors": monitors(app.clone()),
        "windows": build_results,
        "placement": placement(app.clone()),
        "focus": focus.iter().map(|(l,f,v)| serde_json::json!({"label":l,"focused":f,"visible":v})).collect::<Vec<_>>(),
        "verdict": {
            "S1_all_windows_built": build_results.values().all(|v| v["built"] == true),
            "S2_quickpaste_did_not_take_focus": !qp_focused,
            "S2_focus_owner_unchanged": focus_unchanged,
            "S2_owner_before": owner_before,
            "S2_owner_after": owner_after,
            "S7_boot_before_page_scripts": s7_ok,
        },
        "probeSelfReports": self_reports,
    });

    println!("\n===SPIKE_RESULT_JSON===\n{}\n===END===", serde_json::to_string_pretty(&out).unwrap());

    if std::env::args().any(|a| a == "--exit") {
        sleep(400).await;
        app.exit(0);
    }
    let _ = Duration::from_millis(1);
}

async fn tokio_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms)))
        .await
        .ok();
}

fn main() {
    tauri::Builder::default()
        .manage(Reports::default())
        .invoke_handler(tauri::generate_handler![
            spawn_probe,
            report_probe,
            close_probe,
            focus_report,
            placement,
            monitors
        ])
        .setup(|app| {
            if std::env::args().any(|a| a == "--auto") {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move { auto_run(h).await });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri çalıştırılamadı");
}
