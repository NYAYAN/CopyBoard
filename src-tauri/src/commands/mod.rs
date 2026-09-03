//! Renderer'dan çağrılan komutlar.
//!
//! Electron'da 78 IPC kanalı vardı: 6'sı `invoke` (cevap dönen), 72'si `send`
//! (tek yön). Tauri'de bu ayrım yok — hepsi `invoke`, dönüşü olmayanların
//! sonucu yok sayılıyor. `api-tauri.js` eski `window.api` yüzeyini birebir
//! koruduğu için renderer bunu hiç fark etmiyor.
//!
//! ## ⚠ KURAL: pencereye dokunan her komut `async fn` — ölçüldü (2026-09-02)
//!
//! Senkron bir `#[tauri::command]` Windows'ta WebView2'nin `WebMessageReceived` geri
//! çağrısının İÇİNDE, ana thread'de koşar. Orada `hide()`, `show()`, `minimize()`,
//! `set_focus()`, pencere kurma ya da `popup_menu` gibi eşzamanlı Win32 çağrıları
//! yapmak ana thread'i kilitliyor: uygulama "yanıt vermiyor"a düşüyor, Windows olay
//! günlüğüne `Application Hang (AppHangB1)` yazılıyor ve süreç 0xCFFFFFFF ile
//! sonlandırılıyor. Kullanıcıda görünen hâli: listeden kopyalama "kopyalandı" deyip
//! panoyu değiştirmiyor, Büyük Görüntüle açılmıyor, küçült çalışmıyor, widget kapat/aç
//! sonrası gelmiyor — hepsi aynı kilitlenme.
//!
//! `async fn` komutlar Tauri'nin runtime thread'inde koşar; pencere çağrıları olay
//! döngüsüne mesaj olarak gider ve IPC geri çağrısı döndükten SONRA işlenir. Yalnız
//! veri döndüren komutlar (`get_history`, `take_capture_frame`) senkron kalabilir.
//! `Request<'_>` gibi ödünç parametre alanlar `async` olamaz; onlar işi
//! `tauri::async_runtime::spawn` ile devrediyor (bkz. `snip_copy_buffer`).
//! Not: `async` komut `tauri::State<'_, T>` parametresi de alamaz — `app.state()` ile
//! içeriden çekiliyor.

pub mod capture;
pub mod clipboard;
pub mod core;
pub mod gallery;
pub mod viewer;
pub mod widget;
pub mod ready;
pub mod record;
pub mod shortcuts;
