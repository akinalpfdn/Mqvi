/// Tauri application entry point.
///
/// Registers plugins, creates a system tray icon and starts the webview window.
/// The frontend (React) is either served from Vite dev server (development)
/// or bundled into the binary (production).
///
/// Plugins:
/// - `tauri-plugin-updater`: Auto-update (imzalı güncelleme indirip kurar)
/// - `tauri-plugin-process`: Process control (relaunch after update/settings change)
///
/// System Tray:
/// Pencere kapatıldığında (X butonu) uygulama kapanmaz — sadece gizlenir.
/// Tray ikonuna sol tık ile pencere geri açılır.
/// Sağ tık menüsünden "Show mqvi" veya "Quit" seçilebilir.
/// Discord benzeri davranış: arka planda çalışmaya devam eder (WS, voice vb.)
///
/// Audio Capture:
/// WASAPI per-process audio capture (Windows-only).
/// Screen share sırasında kendi uygulamamızın sesini hariç tutarak
/// sistem sesini yakalar → voice chat echo olmaz.
/// Frontend'den `invoke("start_audio_capture")` / `invoke("stop_audio_capture")`
/// ile kontrol edilir.

mod audio_capture;

use std::sync::Mutex;
use tauri::{
    Manager, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

/// Tauri managed state: WASAPI audio capture controller.
///
/// Mutex ile sarılır çünkü Tauri command'ları farklı thread'lerden çağrılabilir.
/// AudioCapture içindeki AtomicBool thread-safe olsa da, Tauri State<T> için
/// Sync trait gerekir — Mutex bunu sağlar.
struct AudioCaptureState(Mutex<audio_capture::AudioCapture>);

/// Tauri command: WASAPI per-process audio capture başlat.
///
/// Frontend'den çağrılır:
/// ```typescript
/// await invoke("start_audio_capture");
/// ```
///
/// Background thread'de WASAPI capture loop başlatır.
/// 48kHz stereo i16 PCM chunk'ları "audio-pcm" event'i ile frontend'e gönderilir.
/// Hata durumunda string mesaj döner (frontend toast gösterebilir).
#[tauri::command]
fn start_audio_capture(
    app: tauri::AppHandle,
    state: tauri::State<AudioCaptureState>,
) -> Result<(), String> {
    let capture = state
        .0
        .lock()
        .map_err(|e| format!("State lock failed: {}", e))?;
    capture.start(app)
}

/// Tauri command: WASAPI audio capture durdur.
///
/// Frontend'den çağrılır:
/// ```typescript
/// await invoke("stop_audio_capture");
/// ```
///
/// AtomicBool flag'i false yapar → background thread temiz kapanır.
/// Capture zaten çalışmıyorsa sessizce başarılı döner.
#[tauri::command]
fn stop_audio_capture(state: tauri::State<AudioCaptureState>) -> Result<(), String> {
    let capture = state
        .0
        .lock()
        .map_err(|e| format!("State lock failed: {}", e))?;
    capture.stop();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ─── Managed State ───
        // AudioCaptureState: WASAPI capture controller.
        // Tauri command'ları State<AudioCaptureState> parametresi ile erişir.
        .manage(AudioCaptureState(Mutex::new(
            audio_capture::AudioCapture::new(),
        )))
        // ─── Tauri Commands ───
        // Frontend'den invoke() ile çağrılabilecek Rust fonksiyonları.
        // generate_handler!: Compile-time macro — command isimlerini string olarak
        // kaydeder, type-safe deserialization sağlar.
        .invoke_handler(tauri::generate_handler![
            start_audio_capture,
            stop_audio_capture
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                // ─── Plugins ───
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;

                // ─── System Tray ───
                // Sağ tık menü öğeleri
                let show_i = MenuItem::with_id(app, "show", "Show mqvi", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

                // Tray ikonu oluştur
                let mut builder = TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("mqvi")
                    // Sol tık → pencere aç (menü değil). Sağ tık → menü.
                    .show_menu_on_left_click(false)
                    // Sağ tık menü event handler
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            // Uygulamadan tamamen çık — tray dahil her şeyi kapat
                            app.exit(0);
                        }
                        _ => {}
                    })
                    // Sol tık event handler — pencereyi göster
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    });

                // İkon: tauri.conf.json'daki bundle ikonunu kullan (ayrı dosya gerekmez)
                if let Some(icon) = app.default_window_icon() {
                    builder = builder.icon(icon.clone());
                }

                builder.build(app)?;
            }
            Ok(())
        })
        // ─── Pencere kapatma → gizle (tray'e küçült) ───
        // X butonuna basıldığında pencere kapatılmaz, sadece gizlenir.
        // Kullanıcı tray ikonuna tıklayarak veya sağ tık → "Show mqvi" ile geri açar.
        // Gerçek çıkış: tray menüsündeki "Quit" veya taskbar sağ tık → Close.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
