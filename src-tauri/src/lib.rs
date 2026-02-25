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
use tauri::{
    Manager, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
