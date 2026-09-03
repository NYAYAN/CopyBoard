//! Ana thread bekçisi — yalnız hata ayıklama derlemesi.
//!
//! Neden var: 2026-09-02'de iki ayrı ana thread kilitlenmesi (senkron komutlar,
//! kısayol işleyicisi içinde kısayol kaydı) saatlerce "hiçbir şey olmuyor" olarak
//! göründü; panik yok, log yok, WebView2 çizmeye devam ediyor. Windows'un
//! `Application Hang` kaydı tek ipucuydu. Bu bekçi ana thread'i saniyede bir yoklar;
//! 3 sn yanıt gelmezse günlüğe ERROR yazar — böylece kilitlenme anı, öncesindeki
//! son log satırlarıyla birlikte dosyada kalır.

#![cfg(debug_assertions)]

use std::sync::mpsc;
use std::time::Duration;

pub fn start(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("copyboard-watchdog".into())
        .spawn(move || {
            let mut stuck_since: Option<std::time::Instant> = None;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let (tx, rx) = mpsc::channel();
                if app.run_on_main_thread(move || { let _ = tx.send(()); }).is_err() {
                    return; // olay döngüsü kapandı
                }
                match rx.recv_timeout(Duration::from_secs(3)) {
                    Ok(()) => {
                        if let Some(since) = stuck_since.take() {
                            log::warn!("bekçi: ana thread {} sn sonra yeniden yanıt verdi", since.elapsed().as_secs());
                        }
                    }
                    Err(_) => {
                        let since = *stuck_since.get_or_insert_with(std::time::Instant::now);
                        log::error!(
                            "bekçi: ANA THREAD YANIT VERMİYOR ({} sn) — kilitlenme; hemen önceki log satırlarına bakın",
                            since.elapsed().as_secs() + 3
                        );
                    }
                }
            }
        })
        .expect("watchdog thread");
}
