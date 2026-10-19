//! snapshot-capture — one frame through the shipping capture path, written to a BMP.
//!
//! The only way to see what viewers would get without a room: on an HDR display it goes through
//! the FP16 + tone-map path exactly as a share does. Usage:
//!   snapshot-capture <out.bmp> [window-title-substring]
//! With no title it captures the primary monitor.

use std::io::Write;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use mqvi_game_capture::capture::ScreenCapture;

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args = std::env::args().skip(1);
    let out = args.next().context("usage: snapshot-capture <out.bmp> [window-title]")?;
    let mut cap = match args.next() {
        Some(title) => ScreenCapture::window_by_title(&title)?,
        None => ScreenCapture::primary_monitor()?,
    };

    // WGC is change-driven, but the first frame comes on its own once the session starts.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(f) = cap.next_frame()? {
            write_bmp(&out, f.data, f.width, f.height, f.stride)?;
            println!("wrote {out} ({}x{})", f.width, f.height);
            return Ok(());
        }
        if Instant::now() > deadline {
            bail!("no frame within 3s");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 32-bit top-down BMP: the BGRA rows go in as they are, minus the stride padding.
fn write_bmp(path: &str, bgra: &[u8], width: u32, height: u32, stride: usize) -> Result<()> {
    let row = width as usize * 4;
    let image = row * height as usize;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"BM")?;
    f.write_all(&(54 + image as u32).to_le_bytes())?;
    f.write_all(&0u32.to_le_bytes())?;
    f.write_all(&54u32.to_le_bytes())?;
    f.write_all(&40u32.to_le_bytes())?;
    f.write_all(&(width as i32).to_le_bytes())?;
    f.write_all(&(-(height as i32)).to_le_bytes())?; // negative = top-down
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&32u16.to_le_bytes())?;
    f.write_all(&[0u8; 24])?; // BI_RGB, no size/resolution/palette
    for y in 0..height as usize {
        f.write_all(&bgra[y * stride..y * stride + row])?;
    }
    Ok(())
}
