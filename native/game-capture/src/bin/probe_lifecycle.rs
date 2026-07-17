//! probe-lifecycle — watches a capture react to its source resizing and closing (NGC-06).
//!
//! The capture layer is otherwise only reachable through the pump, which needs a LiveKit room to
//! start — so the resize and close paths could not be exercised locally at all. That gap is exactly
//! how a resize crash shipped. This drives ScreenCapture directly: no encoder, no network.
//!
//! Usage: probe-lifecycle <HWND>    (resize or close that window and watch what it reports)

use std::time::{Duration, Instant};

use mqvi_game_capture::capture::ScreenCapture;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let handle: isize = match std::env::args().nth(1).and_then(|a| a.parse().ok()) {
        Some(h) => h,
        None => {
            eprintln!("usage: probe-lifecycle <HWND>");
            std::process::exit(2);
        }
    };

    let mut cap = match ScreenCapture::window_by_handle(handle) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot capture window {handle}: {e:#}");
            std::process::exit(1);
        }
    };
    println!("capturing hwnd={handle}: {}x{}", cap.width(), cap.height());

    let start = Instant::now();
    let mut frames = 0u32;
    let mut last = (cap.width(), cap.height());

    // 30 seconds is enough to resize the window a few times and then close it.
    while start.elapsed() < Duration::from_secs(30) {
        match cap.next_frame() {
            Ok(Some(f)) => {
                frames += 1;
                if (f.width, f.height) != last {
                    println!("frames now {}x{} (were {}x{})", f.width, f.height, last.0, last.1);
                    last = (f.width, f.height);
                }
            }
            Ok(None) => {}
            Err(e) => {
                println!("SOURCE GONE after {frames} frames: {e:#}");
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(33));
    }
    println!("still capturing after 30s ({frames} frames) — source never reported gone");
}
