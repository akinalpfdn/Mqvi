/// Tauri application entry point.
///
/// Registers plugins and starts the webview window.
/// The frontend (React) is either served from Vite dev server (development)
/// or bundled into the binary (production).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Desktop-only plugins: process (for relaunch after settings change)
            // TODO: Re-enable updater once signing keypair is generated:
            //   app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
