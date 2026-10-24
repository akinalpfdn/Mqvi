//! macOS: drives the ScreenCaptureKit capture with no room, for a set time, and logs what arrives.
//!
//! The same capture the helper ships (`mac_capture`), feeding a video source nothing subscribes to.
//! It answers what a share cannot be started to find out: whether Screen Recording is granted (and
//! how a refusal looks), the real pixel size of a frame, and how many new frames a static and a
//! moving screen produce.
//!
//! Usage: `probe-sck [seconds] [display-id]` — 10 s on the main display by default.

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use std::time::Duration;

    use livekit::webrtc::video_source::native::NativeVideoSource;
    use livekit::webrtc::video_source::VideoResolution;
    use mqvi_game_capture::mac_capture::{MacCapture, Source, Target};

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args = std::env::args().skip(1);
    let seconds: u64 = args.next().map(|s| s.parse()).transpose()?.unwrap_or(10);
    let target = match args.next() {
        Some(id) => Target::Display(id.parse()?),
        None => Target::MainDisplay,
    };

    // livekit's video source spawns onto the ambient tokio runtime; the helper always has one.
    let rt = tokio::runtime::Runtime::new()?;
    let _in_runtime = rt.enter();

    let source = Source::find(target)?;
    log::info!("{}: {}x{} pixels", source.label(), source.width(), source.height());
    let canvas = fit_1080((source.width(), source.height()));
    log::info!("capturing at {}x{}", canvas.0, canvas.1);
    let video = NativeVideoSource::new(VideoResolution { width: canvas.0, height: canvas.1 }, true);
    let capture = MacCapture::start(
        &source,
        canvas,
        30,
        video,
        fit_1080,
        || log::info!("first frame handed over"),
        |ended| log::warn!("capture ended: {ended:?}"),
    )?;
    std::thread::sleep(Duration::from_secs(seconds));
    drop(capture);
    log::info!("stopped");
    Ok(())
}

/// Measured at a size a share really streams: at most 1080 high, aspect kept.
#[cfg(target_os = "macos")]
fn fit_1080((w, h): (u32, u32)) -> (u32, u32) {
    let height = h.min(1080);
    let width = (u64::from(w) * u64::from(height) / u64::from(h.max(1))) as u32;
    (width & !1, height & !1)
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("probe-sck is macOS-only");
}
