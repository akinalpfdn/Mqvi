//! test-capture-encode — WGC screen → BGRA→NV12 → hardware encoder → .h264 (NGC-03 M2).
//!
//! Local, no LiveKit: proves the real screen captures, converts, and hardware-encodes into a
//! valid stream. Decode a frame of the output with ffmpeg to confirm it's the actual desktop.

use std::time::{Duration, Instant};

use anyhow::Result;
use mqvi_game_capture::{capture::ScreenCapture, mf_encoder::HwEncoder, nv12};

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cap = ScreenCapture::primary_monitor()?;
    let (w, h) = (cap.width() & !1, cap.height() & !1);
    println!("capturing {w}x{h}");

    HwEncoder::startup()?;
    let mut enc = HwEncoder::new(w, h, 30, 12_000_000, false)?;
    println!("encoder: {}", enc.name());

    let frame_us = 33_333i64;
    let mut stream = Vec::new();
    let (mut captured, mut packets) = (0u64, 0u32);
    let start = Instant::now();

    // WGC is change-driven: capture whatever arrives over ~6s (move a window to generate frames).
    while start.elapsed() < Duration::from_secs(6) && captured < 90 {
        match cap.next_frame() {
            Some(f) => {
                let nv12 = nv12::bgra_to_nv12(&f.data, w as usize, h as usize, f.stride);
                for p in enc.encode(&nv12, captured as i64 * frame_us, frame_us, captured == 0)? {
                    packets += 1;
                    stream.extend_from_slice(&p.data);
                }
                captured += 1;
            }
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    }

    let out = std::env::temp_dir().join("mqvi_screen.h264");
    std::fs::write(&out, &stream)?;
    println!(
        "captured {captured} screen frames, {packets} packets, {} bytes → {}",
        stream.len(),
        out.display()
    );
    if packets == 0 {
        anyhow::bail!("no packets — did the screen change? try moving a window");
    }
    Ok(())
}
