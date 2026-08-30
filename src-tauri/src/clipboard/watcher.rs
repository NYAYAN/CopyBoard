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
/// Ana thread'e devredilmiş bir pano okuması uçuşta mı?
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
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
    // Yoklama, ana thread'e bir closure devrediyor. Ana thread 2 sn'den uzun
    // bloklanırsa (modal menü, uzun bir işlem) her tur kuyruğa BİR YENİ closure daha
    // eklerdi; blok kalkınca hepsi arka arkaya koşup panoyu defalarca okurdu.
    // Uçuşta bir istek varken yenisi gönderilmiyor.
    if IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return None;
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            IN_FLIGHT.store(false, Ordering::Release);
        }
    }
    let _guard = Guard;

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

/// Açılışta panonun o anki sayacını okur. Okunamazsa -1 döner ve ilk tur normal
/// çalışır (en kötü ihtimalle var olan içerik geçmişin başına taşınır — Electron'un
/// davranışı da buydu).
fn seed_change_count(app: &tauri::AppHandle) -> i64 {
    let (tx, rx) = std::sync::mpsc::channel();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(crate::platform::clipboard_change_count());
        })
        .is_err()
    {
        return -1;
    }
    rx.recv_timeout(MAIN_THREAD_TIMEOUT).unwrap_or(-1)
}

/// Makine uyurken veya ekran kilitliyken yoklama duruyor.
static PAUSED: AtomicBool = AtomicBool::new(false);

/// Uyku/kilit başlangıcı: yoklamayı durdur ve BEKLEYEN YAZMALARI DİSKE BOŞALT.
///
/// Boşaltma isteğe bağlı değil: geçmiş 500 ms geciktirilerek yazılıyor ve uyku bu
/// pencereden uzun sürüyor. Uyanmadan kapanan bir makinede son kopyalanan içerik
/// kaybolurdu.
pub fn pause(app: &tauri::AppHandle) {
    if PAUSED.swap(true, Ordering::AcqRel) {
        return;
    }
    log::debug!("uyku/kilit — pano yoklaması durduruldu");
    app.state::<AppState>().store.flush();
}

/// Uyanma/kilit açılışı: yoklamayı sürdür.
///
/// Değişim sayacı BİLEREK yeniden tohumlanmıyor: kilitliyken kopyalanan bir içerik
/// kilit açılınca geçmişe girmeli — Electron'da da öyleydi (yoklama yeniden
/// başlıyordu ama `lastText` karşılaştırması aynı kalıyordu).
pub fn resume(app: &tauri::AppHandle) {
    if !PAUSED.swap(false, Ordering::AcqRel) {
        return;
    }
    let _ = app;
    log::debug!("uyanma/kilit açıldı — pano yoklaması sürdü");
}

/// Açılışta panodaki metni, geçmişte HENÜZ YOKSA bir kez ekler.
///
/// Zaten varsa dokunulmuyor — amaç kaydı kaybetmemek, sıralamayı bozmak değil.
fn capture_startup_clipboard_if_new(app: &tauri::AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel();
    let h = app.clone();
    if h.run_on_main_thread(move || {
        let _ = tx.send(if crate::platform::clipboard_is_concealed() {
            None
        } else {
            crate::platform::clipboard_read_text()
        });
    })
    .is_err()
    {
        return;
    }
    let Ok(Some(text)) = rx.recv_timeout(MAIN_THREAD_TIMEOUT) else { return };
    if text.is_empty() {
        return;
    }

    let state = app.state::<AppState>();
    if state.settings().clipboard_paused() {
        return;
    }
    // Zaten geçmişte veya favorilerde mi?
    let known = |list: Vec<serde_json::Value>| {
        list.iter()
            .any(|i| i.get("content").and_then(|c| c.as_str()) == Some(text.as_str()))
    };
    if known(state.store.get("history", Vec::new())) || known(state.store.get("favorites", Vec::new())) {
        state.runtime.lock().unwrap().last_text = text;
        return;
    }

    log::debug!("açılışta panodaki içerik geçmişte yok — bir kez ekleniyor");
    state.runtime.lock().unwrap().last_text = text.clone();
    super::history::add(app, &text);
}

pub fn start(app: tauri::AppHandle) -> Watcher {
    let running = Arc::new(AtomicBool::new(true));
    let flag = running.clone();

    std::thread::Builder::new()
        .name("copyboard-clipboard".into())
        .spawn(move || {
            // ── Açılışta panoda ne varsa ────────────────────────────────────
            //
            // Electron her açılışta panodaki içeriği geçmişe EKLİYORDU. Yan etkisi:
            // kullanıcının bir saat önce kopyaladığı şey, uygulamayı her açtığında
            // yeni bir kayıt gibi listenin başına atlıyor ve sıralamayı bozuyordu.
            //
            // Ama körü körüne yok saymak da kayıp demek: kullanıcı bir şey kopyalayıp
            // SONRA CopyBoard'u açtıysa o içerik hiç yakalanmıyordu.
            //
            // Bu yüzden ikisi de değil: sayaç tohumlanıyor (yani içerik "görülmüş"
            // sayılıyor, tekrar tekrar başa taşınmıyor) AMA geçmişte hiç yoksa bir kez
            // ekleniyor.
            //
            // Tohumlama bir "ilk tur" bayrağıyla değil SAYAÇLA yapılıyor: bayrak
            // yaklaşımı, açılışta panoda METİN YOKSA (resim/dosya/boş) ya da içerik
            // gizliyse bir sonraki turlara taşınıyor ve kullanıcının YAPTIĞI İLK
            // GERÇEK KOPYAYI sessizce yutuyordu.
            let mut last_count = seed_change_count(&app);
            capture_startup_clipboard_if_new(&app);

            while flag.load(Ordering::Acquire) {
                std::thread::sleep(POLL_INTERVAL);
                if !flag.load(Ordering::Acquire) {
                    break;
                }
                if PAUSED.load(Ordering::Acquire) {
                    continue;
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
