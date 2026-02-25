/// Tauri application entry point.
///
/// Registers plugins and starts the webview window.
/// The frontend (React) is either served from Vite dev server (development)
/// or bundled into the binary (production).
///
/// Plugins:
/// - `tauri-plugin-updater`: Auto-update (imzalı güncelleme indirip kurar)
/// - `tauri-plugin-process`: Process control (relaunch after update/settings change)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
