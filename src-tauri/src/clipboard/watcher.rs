//! Pano izleyici.
//!
//! ## Electron'dan farkı: önce sayaç, sonra metin
//!
//! Electron sürümü saniyede bir `clipboard.readText()` çağırıyordu — büyük bir kopya
//! panodaysa bu, her saniye megabaytların kopyalanması demekti. Burada önce
//! `changeCount` (macOS) / `GetClipboardSequenceNumber` (Windows) okunuyor; değişmediyse
//! metne hiç dokunulmuyor. Boşta maliyet: saniyede bir tam sayı karşılaştırması.
//!
//! ## Gizli pano
//!
//! Parola yöneticilerinin sentinel tipleri, metin OKUNMADAN ÖNCE kontrol ediliyor
//! (bkz. [`crate::platform::clipboard_is_concealed`]). Bu davranışı kaybetmek gerçek
//! bir güvenlik gerilemesidir.
//!
//! ## Ana thread
//!
//! `NSPasteboard` iş parçacığı güvenli değil. Yoklama arka planda uyuyor ama pano
//! okuması ana thread'e devrediliyor — `platform/macos` modülünün tamamı için geçerli
//! olan kuralın (BULGU S1-a) burada da uygulanması.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;

use crate::state::AppState;

const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Ana thread meşgulse (modal menü, uzun bir işlem) yoklamayı sonsuza dek
/// bekletme — bir tur atla, bir sonraki saniyede tekrar dene.
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Clone)]
pub struct Watcher {
    running: Arc<AtomicBool>,
}

impl Watcher {
    /// İzleyiciyi durdurur (çıkışta).
    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
    }
}

/// Panonun o anki durumunu ana thread'den okur.
/// `None` → pano değişmedi ya da okunacak metin yok.
fn read_if_changed(app: &tauri::AppHandle, last_count: &mut i64) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let previous = *last_count;

    let dispatched = app.run_on_main_thread(move || {
        let count = crate::platform::clipboard_change_count();
        if count == previous {
            let _ = tx.send(Ok(None));
            return;
        }
        // Gizli içerik: sayacı GÜNCELLE ama metni okuma. Güncellemezsek her turda
        // yeniden kontrol ederiz; okursak parola geçmişe düşer.
        if crate::platform::clipboard_is_concealed() {
            let _ = tx.send(Ok(Some((count, None))));
            return;
        }
        let text = crate::platform::clipboard_read_text();
        let _ = tx.send(Ok(Some((count, text))));
    });

    if dispatched.is_err() {
        return None;
    }
    match rx.recv_timeout(MAIN_THREAD_TIMEOUT) {
        Ok(Ok(Some((count, text)))) => {
            *last_count = count;
            text
        }
        Ok(Ok(None)) => None,
        Ok(Err(())) | Err(_) => None,
    }
}

pub fn start(app: tauri::AppHandle) -> Watcher {
    let running = Arc::new(AtomicBool::new(true));
    let flag = running.clone();

    std::thread::Builder::new()
        .name("copyboard-clipboard".into())
        .spawn(move || {
            // İlk turda panoda ne varsa onu "zaten görülmüş" say: uygulama açılışı,
            // kullanıcının bir saat önce kopyaladığı şeyi yeni bir kayıt gibi
            // geçmişin başına atmamalı.
            let mut last_count = -1i64;
            let mut first_tick = true;

            while flag.load(Ordering::Acquire) {
                std::thread::sleep(POLL_INTERVAL);
                if !flag.load(Ordering::Acquire) {
                    break;
                }

                let Some(text) = read_if_changed(&app, &mut last_count) else {
                    continue;
                };
                if text.is_empty() {
                    continue;
                }

                let state = app.state::<AppState>();
                {
                    let mut rt = state.runtime.lock().unwrap();
                    if rt.last_text == text {
                        continue;
                    }
                    rt.last_text = text.clone();
                }

                if first_tick {
                    first_tick = false;
                    continue;
                }

                // Gizli mod: `last_text`i güncelledik (böylece devam edildiğinde
                // bu kayıt geriye dönük yakalanmaz) ama geçmişe YAZMIYORUZ.
                if state.settings().clipboard_paused() {
                    continue;
                }
                super::history::add(&app, &text);
            }
            log::debug!("pano izleyici durdu");
        })
        .expect("pano izleyici thread'i başlatılamadı");

    Watcher { running }
}
