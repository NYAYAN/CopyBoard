//! Widget ve hızlı yapıştır komutları.

use tauri::Manager;

use crate::state::AppState;

/// Renderer, tıklanabilir yüzeylerinin geometrisini bildiriyor. Hit-test Rust'ta
/// yapılıyor çünkü Tauri'nin `set_ignore_cursor_events`'inde `forward` yok ve
/// geçirgen bir pencere macOS'ta hiç mousemove almıyor (bkz. `windows/widget.rs`).
/// Bir pencere tıklanabilir yüzeylerinin geometrisini bildiriyor.
///
/// Hit-test ana süreçte yapılıyor: Tauri'nin `set_ignore_cursor_events`'inde `forward`
/// yok ve geçirgen bir pencere macOS'ta hiç mousemove almıyor (BULGU F5-d).
#[tauri::command]
pub fn set_hit_areas(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    areas: Vec<crate::windows::hit_test::HitArea>,
    zoom: Option<f64>,
    note_front_app: Option<bool>,
) {
    let label = window.label();
    // Widget'ın zoom'u ve "ön uygulamayı hatırla" davranışı ayarlardan geliyor —
    // renderer'ın bildirdiğine güvenmek yerine burada belirleniyor.
    let (zoom, note) = if label == crate::windows::widget::LABEL {
        (crate::windows::widget::scale(&app), true)
    } else {
        (zoom.unwrap_or(1.0), note_front_app.unwrap_or(false))
    };
    crate::windows::hit_test::set_areas(&app, label, areas, zoom, note);
}

#[tauri::command]
pub async fn widget_action(app: tauri::AppHandle, action: String, data: Option<serde_json::Value>) {
    crate::windows::widget::handle_action(&app, &action, data);
}

#[tauri::command]
pub async fn set_show_widget(app: tauri::AppHandle, value: bool) {
    app.state::<AppState>().settings().set_show_widget(value);
    crate::windows::widget::toggle(&app, value);
}

#[tauri::command]
pub async fn set_widget_transparent(app: tauri::AppHandle, value: bool) {
    app.state::<AppState>().settings().set_widget_transparent(value);
    crate::windows::widget::push_config(&app);
}

#[tauri::command]
pub async fn set_widget_color(app: tauri::AppHandle, value: String) {
    app.state::<AppState>().settings().set_widget_color(value);
    crate::windows::widget::push_config(&app);
}

#[tauri::command]
pub async fn set_widget_opacity(app: tauri::AppHandle, value: i64) {
    app.state::<AppState>().settings().set_widget_opacity(value.clamp(10, 100));
    crate::windows::widget::push_config(&app);
}

#[tauri::command]
pub async fn set_widget_scale(app: tauri::AppHandle, value: i64) {
    app.state::<AppState>().settings().set_widget_scale(value.clamp(50, 200));
    crate::windows::widget::update_scale(&app);
}

/// Seçilen öğeyi panoya koy, (odak almayan) seçiciyi gizle, sonra kullanıcının
/// içinde olduğu alana doğrudan yapıştır.
#[tauri::command]
pub async fn quickpaste_pick(app: tauri::AppHandle, text: String) {
    if text.is_empty() {
        return;
    }
    {
        let state = app.state::<AppState>();
        // 1 sn'lik izleyici kendi yazdığımızı "yeni" sanmasın diye önceden tohumla.
        state.runtime.lock().unwrap().last_text = text.clone();
    }
    crate::platform::clipboard_write_text(&text);
    crate::windows::quickpaste::hide(&app);

    // macOS sentetik Cmd+V'yi Erişilebilirlik olmadan reddediyor. İzni iste (sistemin
    // diyaloğunda "Sistem Ayarları'nı Aç" düğmesi var) ve ne olduğunu söyle — kullanıcıyı
    // değişmemiş bir metin alanına bakarken bırakmak yerine. Öğe her hâlükârda panoda,
    // yani elle Cmd+V hâlâ çalışıyor.
    if !crate::platform::can_paste(true) {
        crate::windows::toast::show(
            &app,
            "Otomatik yapıştırma için Erişilebilirlik izni gerekli. Öğe panoya kopyalandı — Cmd+V ile yapıştırabilirsiniz.",
            "error",
        );
        return;
    }

    // Seçicinin gizlenmesi ve panonun oturması için kısa bir an.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(90));
        crate::platform::send_paste();
    });
}

#[tauri::command]
pub async fn quickpaste_dismiss(app: tauri::AppHandle) {
    crate::windows::quickpaste::hide(&app);
}
