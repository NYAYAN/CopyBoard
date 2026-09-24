//! `--widget-flash-test`: widget açılıp kapanırken ve düzen (taraf/yön) değişirken
//! EKRANDA ne göründüğünü ölçer.
//!
//! Pencere dikdörtgenine bakmak yetmiyor: görev çubuğuna yakınken menü açılınca görülen
//! flaş, webview'un yeni pencere şekline birkaç kare GEÇ çizmesinden doğuyordu — pencere
//! doğru yerdeyken içerik yanlış yerdeydi. Bu düzenek DWM'in birleştirdiği ekranı GDI ile
//! kare hızında okuyor ve düğmenin RENGİNDEKİ piksellerin konumunu izliyor: düğme bir an
//! yanlış yerde görünürse o kare yakalanıyor.
//!
//! İki oturum:
//! * **dikey** — sağ yarıda bir sütun: aşağı modda aç/kapa, görev çubuğunun üstüne taşı
//!   (düzen aşağı→yukarı), yukarı modda üç kez aç/kapa, geri taşı.
//! * **yatay** — üstte bir şerit: sağdan sola taşı (taraf sağ→sol), solda aç/kapa, geri taşı.
//!
//! Renderer'ın GERÇEK yolu sınanıyor: tıklama widget sayfasında düğmeye gönderiliyor
//! (menü açılıyor, `expand` gidiyor), taşıma `drag`/`drag-end` ile — kullanıcının faresine
//! dokunulmuyor. Widget ayarları (konum, taraf, göreli konum) sonda geri yazılıyor.
//!
//! Ölçüldü (2026-09-24, 2560×1440): eski kodda yukarı modda HER açılışta 2 kare düğme
//! 339 px yukarıda, kapanışların çoğunda 1 kare hiç yok; yeni kodda ikisi de 0.

#![cfg(all(debug_assertions, target_os = "windows"))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    SRCCOPY,
};

use crate::geom;
use crate::state::AppState;

/// Bir karede düğme renginde kaç piksel var ve düğmenin merkezi nerede (bölgeye göreli,
/// fiziksel). Merkez YOĞUN satır/sütunlardan (en az [`DENSE`] piksel) hesaplanıyor: ekranın
/// başka yerinde beliren birkaç başıboş mavi piksel (ilk ölçümde bölgenin tepesinde,
/// düğmeden bağımsız) konumu sürüklüyordu.
#[derive(Clone, Copy)]
struct Frame {
    t: f64,
    count: u32,
    /// Düğmenin merkezi; görünmüyorsa `None`.
    center: Option<(f64, f64)>,
}

/// Düğme ~48 px çapında: gövdesindeki her satırda/sütunda en az bu kadar piksel var.
const DENSE: u32 = 8;
/// Bu kadar pikselden azı "düğme görünmüyor".
const VISIBLE: u32 = 250;
/// Bu kadar px'ten fazla sapma "yanlış yerde".
const TOLERANCE: f64 = 8.0;

/// Ekranın `(x, y, w, h)` fiziksel bölgesini BGRA olarak okur.
fn grab(x: i32, y: i32, w: i32, h: i32, buf: &mut Vec<u8>) -> bool {
    buf.resize((w * h * 4) as usize, 0);
    // SAFETY: ekran DC'si, bellek DC'si ve bitmap burada açılıp burada kapanıyor; tampon
    // `w*h*4` bayt ve üstten-alta 32 bit DIB olarak isteniyor.
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let ok = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT).is_ok();
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        ok && lines == h
    }
}

fn parse_hex(c: &str) -> Option<(u8, u8, u8)> {
    let c = c.trim().trim_start_matches('#');
    if c.len() != 6 {
        return None;
    }
    let p = |i: usize| u8::from_str_radix(&c[i..i + 2], 16).ok();
    Some((p(0)?, p(2)?, p(4)?))
}

/// Fiziksel bir ekran bölgesi.
#[derive(Clone, Copy)]
struct Region {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// Bölgeyi kare hızında okuyan iş parçacığı.
struct Sampler {
    frames: Arc<Mutex<Vec<Frame>>>,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

impl Sampler {
    /// Önce TABAN alınıyor: widget henüz bölgede değilken düğme renginde olan pikseller
    /// (masaüstündeki mavi bir şey) sonradan sayılmıyor.
    fn start(r: Region, color: (u8, u8, u8), t0: Instant) -> Self {
        let is_btn = move |p: &[u8]| {
            const TOL: i32 = 40;
            (p[2] as i32 - color.0 as i32).abs() <= TOL
                && (p[1] as i32 - color.1 as i32).abs() <= TOL
                && (p[0] as i32 - color.2 as i32).abs() <= TOL
        };
        let mut buf = Vec::new();
        let mut baseline = vec![false; (r.w * r.h) as usize];
        if grab(r.x, r.y, r.w, r.h, &mut buf) {
            for (i, px) in buf.chunks_exact(4).enumerate() {
                baseline[i] = is_btn(px);
            }
        }
        let frames: Arc<Mutex<Vec<Frame>>> = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (frames, stop) = (frames.clone(), stop.clone());
            std::thread::spawn(move || {
                let (w, h) = (r.w as usize, r.h as usize);
                let (mut rows, mut cols) = (vec![0u32; h], vec![0u32; w]);
                while !stop.load(Ordering::Acquire) {
                    if grab(r.x, r.y, r.w, r.h, &mut buf) {
                        rows.iter_mut().for_each(|c| *c = 0);
                        cols.iter_mut().for_each(|c| *c = 0);
                        for (i, px) in buf.chunks_exact(4).enumerate() {
                            if is_btn(px) && !baseline[i] {
                                rows[i / w] += 1;
                                cols[i % w] += 1;
                            }
                        }
                        let count: u32 = rows.iter().sum();
                        let dense_center = |v: &[u32]| {
                            let (mut s, mut n) = (0f64, 0f64);
                            for (i, &c) in v.iter().enumerate() {
                                if c >= DENSE {
                                    s += i as f64 * c as f64;
                                    n += c as f64;
                                }
                            }
                            (n > 0.0).then(|| s / n)
                        };
                        let center = dense_center(&cols).zip(dense_center(&rows));
                        let t = t0.elapsed().as_secs_f64() * 1000.0;
                        frames.lock().unwrap().push(Frame { t, count, center });
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            })
        };
        Self { frames, stop, thread }
    }

    fn finish(self) -> Vec<Frame> {
        self.stop.store(true, Ordering::Release);
        let _ = self.thread.join();
        let f = self.frames.lock().unwrap().clone();
        f
    }
}

/// Her adım için: adım bitmeden önceki son 250 ms'deki düğme konumu "yerleşik" konum.
/// Adım boyunca her kare ona göre: düğme görünür ama BAŞKA yerde (sıçrama) ya da hiç
/// görünmüyor (gizleme). İlki flaş; ikincisi yalnız düzen geçişinde bekleniyor (içerik
/// bilerek bir an gizleniyor). Taşımada bir önceki adımın konumu da geçerli (düğme
/// eskisinden yenisine gidiyor).
fn report(session: &str, frames: &[Frame], marks: &[(f64, String)], r: Region, sc: f64) -> u32 {
    let visible = |f: &Frame| f.count >= VISIBLE && f.center.is_some();
    let settled_at = |b: f64| {
        let mut v: Vec<(f64, f64)> =
            frames.iter().filter(|f| f.t > b - 250.0 && f.t <= b && visible(f)).filter_map(|f| f.center).collect();
        if v.is_empty() {
            return None;
        }
        v.sort_by(|a, b| (a.0 + a.1).partial_cmp(&(b.0 + b.1)).unwrap());
        Some(v[v.len() / 2])
    };
    let fps = frames.len() as f64 / ((frames.last().map(|f| f.t).unwrap_or(1.0) - frames[0].t).max(1.0) / 1000.0);
    println!("WIDGET_FLASH: ── {session}: {} kare (~{fps:.0}/sn)", frames.len());
    let near = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).abs() <= TOLERANCE && (a.1 - b.1).abs() <= TOLERANCE;
    let mut total_jumps = 0;
    let mut prev: Option<(f64, f64)> = None;
    for w in marks.windows(2) {
        let ((a, name), (b, _)) = (&w[0], &w[1]);
        let Some(rest) = settled_at(*b) else {
            println!("WIDGET_FLASH: [{name}] düğme yerleşik hâlde görünmüyor");
            prev = None;
            continue;
        };
        let (mut jumped, mut hidden, mut worst) = (0u32, 0u32, (0f64, 0f64));
        let mut first: Option<f64> = None;
        let mut hidden_ms = (f64::MAX, f64::MIN);
        for f in frames.iter().filter(|f| f.t > *a && f.t <= *b) {
            match f.center {
                Some(c) if visible(f) => {
                    if !near(c, rest) && !prev.is_some_and(|p| near(c, p)) {
                        jumped += 1;
                        let d = (c.0 - rest.0, c.1 - rest.1);
                        if d.0.abs() + d.1.abs() > worst.0.abs() + worst.1.abs() {
                            worst = d;
                        }
                        first.get_or_insert(f.t - a);
                    }
                }
                _ => {
                    hidden += 1;
                    hidden_ms = (hidden_ms.0.min(f.t - a), hidden_ms.1.max(f.t - a));
                }
            }
        }
        total_jumps += jumped;
        println!(
            "WIDGET_FLASH: [{name}] yerleşik ({:.0},{:.0}) | yanlış yerde: {jumped} kare{} | görünmez: {hidden} kare{}",
            (r.x as f64 + rest.0) / sc,
            (r.y as f64 + rest.1) / sc,
            first
                .map(|t| format!(" (ilki +{t:.0} ms, en kötü {:+.0},{:+.0} px)", worst.0 / sc, worst.1 / sc))
                .unwrap_or_default(),
            if hidden > 0 { format!(" (+{:.0}..+{:.0} ms)", hidden_ms.0, hidden_ms.1) } else { String::new() },
        );
        prev = Some(rest);
    }
    total_jumps
}

pub fn run(h: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Widget sayfası yüklensin, ilk düzen uygulansın.
        std::thread::sleep(Duration::from_millis(3000));
        let Some(win) = h.get_webview_window(crate::windows::widget::LABEL) else {
            println!("WIDGET_FLASH: widget penceresi yok (gösterilmiyor olabilir)");
            h.exit(0);
            return;
        };
        let store = &h.state::<AppState>().store;
        let keys = ["widgetPos", "widgetSide", "widgetDockParams"];
        let orig: Vec<(&str, Option<serde_json::Value>)> = keys.iter().map(|k| (*k, store.get_value(k))).collect();
        let Some(m) = geom::primary_monitor(&h) else {
            h.exit(0);
            return;
        };
        let s = crate::windows::widget::scale(&h);
        let btn = 68.0 * s;
        let color = parse_hex(&store.get("widgetColor", "#2459d6".to_string())).unwrap_or((0x24, 0x59, 0xd6));
        let sc = m.scale;

        // Konumlar (mantıksal): sağ yarıda bir sütun — biri görev çubuğunun hemen üstünde
        // (paneller YUKARI açılır), biri üstte (AŞAĞI) — ve sol yarıda aynı yükseklikte bir nokta.
        let x_right = (m.work_x + m.work_width - 300.0).round();
        let x_left = (m.work_x + m.work_width * 0.4).round();
        let y_up = m.work_y + m.work_height - btn - 10.0;
        let y_down = m.work_y + 300.0;
        let column = Region {
            x: ((x_right - 8.0) * sc) as i32,
            y: ((y_down - 60.0) * sc) as i32,
            w: ((btn + 16.0) * sc) as i32,
            h: ((m.work_y + m.work_height - y_down + 60.0) * sc) as i32,
        };
        let band = Region {
            x: ((x_left - 60.0) * sc) as i32,
            y: ((y_down - 20.0) * sc) as i32,
            w: ((x_right - x_left + btn + 120.0) * sc) as i32,
            h: ((btn + 40.0) * sc) as i32,
        };
        println!(
            "WIDGET_FLASH: monitör {}x{} ×{sc}, ölçek {s}, renk {color:?}; sağ x={x_right}, sol x={x_left}, \
             yukarı-mod y={y_up:.0}, aşağı-mod y={y_down:.0}",
            m.width, m.height
        );

        let t0 = Instant::now();
        let ms = move || t0.elapsed().as_secs_f64() * 1000.0;
        let mut drag_id = 7_000_000u64;
        let mut move_to = |x: f64, y: f64| {
            drag_id += 1;
            let v = store.get_value("widgetPos");
            let cx = v.as_ref().and_then(|v| v.get("x")).and_then(|x| x.as_f64()).unwrap_or(x);
            let cy = v.as_ref().and_then(|v| v.get("y")).and_then(|y| y.as_f64()).unwrap_or(y);
            crate::windows::widget::handle_action(&h, "drag", Some(serde_json::json!({ "x": x - cx, "y": y - cy, "id": drag_id })));
            crate::windows::widget::handle_action(&h, "drag-end", Some(serde_json::json!({ "id": drag_id })));
        };
        // Gerçek tıklama yolu: renderer'ın `click` işleyicisi (daire içi denetimi dahil).
        let click = || {
            let _ = win.eval(
                "(() => { const b = document.getElementById('widget-main'); const r = b.getBoundingClientRect(); \
                 b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, \
                 clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); })()",
            );
        };
        let pause = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
        let mut marks: Vec<(f64, String)> = Vec::new();
        let mut jumps = 0;

        // ── Dikey oturum ───────────────────────────────────────────────────────────────
        // Başlangıç konumu sütunda olmasın ki taban temiz alınsın.
        move_to(x_left, y_down);
        pause(900);
        let sampler = Sampler::start(column, color, t0);
        pause(200);
        marks.push((ms(), "aşağıya taşındı".into()));
        move_to(x_right, y_down);
        pause(1000);
        marks.push((ms(), "aşağı: aç".into()));
        click();
        pause(800);
        marks.push((ms(), "aşağı: kapat".into()));
        click();
        pause(1000);
        marks.push((ms(), "görev çubuğunun üstüne (düzen aşağı→yukarı)".into()));
        move_to(x_right, y_up);
        pause(1000);
        for i in 1..=3 {
            marks.push((ms(), format!("yukarı: aç #{i}")));
            click();
            pause(800);
            marks.push((ms(), format!("yukarı: kapat #{i}")));
            click();
            pause(1000);
        }
        marks.push((ms(), "yukarıdan geri (düzen yukarı→aşağı)".into()));
        move_to(x_right, y_down);
        pause(1000);
        marks.push((ms(), "son".into()));
        let frames = sampler.finish();
        jumps += report("dikey", &frames, &marks, column, sc);

        // ── Yatay oturum ───────────────────────────────────────────────────────────────
        marks.clear();
        // Taban temiz alınsın: düğme önce şeridin dışına (aynı taraf ve yön, düzen değişmiyor).
        move_to(x_right, y_down + 200.0);
        pause(900);
        let sampler = Sampler::start(band, color, t0);
        pause(200);
        marks.push((ms(), "şeride".into()));
        move_to(x_right, y_down);
        pause(1000);
        marks.push((ms(), "sola (taraf sağ→sol)".into()));
        move_to(x_left, y_down);
        pause(1000);
        marks.push((ms(), "sol: aç".into()));
        click();
        pause(800);
        marks.push((ms(), "sol: kapat".into()));
        click();
        pause(1000);
        marks.push((ms(), "sağa (taraf sol→sağ)".into()));
        move_to(x_right, y_down);
        pause(1000);
        marks.push((ms(), "son".into()));
        let frames = sampler.finish();
        jumps += report("yatay", &frames, &marks, band, sc);

        for (k, v) in orig {
            if let Some(v) = v {
                store.set(k, v);
            }
        }
        println!(
            "WIDGET_FLASH: SONUÇ — yanlış yerde toplam {jumps} kare{}",
            if jumps == 0 { " (flaş yok)" } else { "" }
        );
        h.exit(0);
    });
}
