// Prevents an extra console window on Windows in release builds.
// In debug builds, the console stays visible for log output.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mqvi_lib::run()
}
