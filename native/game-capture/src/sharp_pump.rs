//! "Net Görüntü" through the helper: the same WGC capture (and HDR tone-map) as smooth, handed to
//! libwebrtc as raw NV12 for its software VP9 — the encoder the browser engine uses too.
//!
//! The app routes a sharp share here only when the browser cannot capture it correctly, i.e. on an
//! HDR display, where Chromium clips HDR content to 8-bit. Everywhere else sharp stays in the
//! browser, untouched.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use livekit::webrtc::video_frame::{NV12Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use mqvi_game_capture::capture::ScreenCapture;
use mqvi_game_capture::nv12;
use tokio::sync::oneshot;

use super::{canvas_for, VideoConfig, RESIZE_SETTLE};

/// What the app is told is encoding, in the same slot the hardware encoder's name fills.
pub const ENCODER_NAME: &str = "libwebrtc software VP9";

/// Captures at `cfg.fps` on an absolute schedule and feeds every tick to libwebrtc, repeating the
/// last frame while the screen is still — WGC only delivers on change, and an encoder that gets no
/// input cannot answer a new viewer's keyframe request.
pub fn sharp_pump(
    source: NativeVideoSource,
    cfg: VideoConfig,
    mut capture: ScreenCapture,
    stop: Arc<AtomicBool>,
    ready: oneshot::Sender<String>,
) -> Result<()> {
    let VideoConfig { mut width, mut height, fps, max, .. } = cfg;

    #[cfg(windows)]
    let _mmcss = super::MmcssHandle::register("Capture");

    let frame_us = 1_000_000i64 / fps as i64;
    let t0 = Instant::now();
    let mut idx: u64 = 0;
    // The NV12 conversion target, kept across frames, and the last frame handed to libwebrtc —
    // re-sent as-is on a still screen, so a repeat costs no conversion and no allocation.
    let mut nv12 = Vec::new();
    let mut last: Option<VideoFrame<NV12Buffer>> = None;
    let mut wanted: Option<((u32, u32), Instant)> = None;
    let mut ready = Some(ready);

    let mut captured = 0u32;
    let mut sent = 0u32;
    let mut last_report = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        let due = t0 + Duration::from_micros(idx * frame_us as u64);
        if let Some(d) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(d);
        }

        // An error is the source going away; ending the process is how the app learns.
        if let Some(f) = capture.next_frame()? {
            let (fw, fh) = (f.width, f.height);
            nv12::bgra_to_nv12_fit_into(
                f.data,
                fw as usize,
                fh as usize,
                f.stride,
                width as usize,
                height as usize,
                &mut nv12,
            );
            last = Some(VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: 0,
                frame_metadata: None,
                buffer: nv12_buffer(&nv12, width, height),
            });
            captured += 1;

            // Same rule as the hardware pump: follow a resized source once it holds still. libwebrtc
            // takes the new size on its own; all that changes here is the canvas.
            let want = canvas_for(fw, fh, max);
            if want == (width, height) {
                wanted = None;
            } else {
                let settled = match wanted {
                    Some((w, since)) if w == want => since.elapsed() >= RESIZE_SETTLE,
                    _ => {
                        wanted = Some((want, Instant::now()));
                        false
                    }
                };
                if settled {
                    log::info!("stream {width}x{height} → {}x{} (source settled)", want.0, want.1);
                    (width, height) = want;
                    wanted = None;
                }
            }
        }

        // Nothing captured yet (a window that isn't drawing): keep the schedule moving rather than
        // polling flat out.
        if let Some(frame) = last.as_mut() {
            frame.timestamp_us = idx as i64 * frame_us;
            source.capture_frame(frame);
            sent += 1;
            if let Some(tx) = ready.take() {
                let _ = tx.send(ENCODER_NAME.to_string());
            }
        }
        idx += 1;

        if last_report.elapsed() >= Duration::from_secs(1) {
            let secs = last_report.elapsed().as_secs_f64();
            log::info!(
                "sharp: captured {:.1} fps, sent {:.1} fps | {width}x{height}",
                captured as f64 / secs,
                sent as f64 / secs
            );
            captured = 0;
            sent = 0;
            last_report = Instant::now();
        }
    }
    Ok(())
}

/// Copies a tightly packed NV12 frame into a fresh libwebrtc buffer, which may pad its rows.
fn nv12_buffer(nv12: &[u8], width: u32, height: u32) -> NV12Buffer {
    let (w, h) = (width as usize, height as usize);
    let mut buf = NV12Buffer::new(width, height);
    let (stride_y, stride_uv) = buf.strides();
    let (sy, suv) = (stride_y as usize, stride_uv as usize);
    let (dst_y, dst_uv) = buf.data_mut();
    for row in 0..h {
        dst_y[row * sy..row * sy + w].copy_from_slice(&nv12[row * w..row * w + w]);
    }
    let uv = &nv12[w * h..];
    for row in 0..h / 2 {
        dst_uv[row * suv..row * suv + w].copy_from_slice(&uv[row * w..row * w + w]);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::nv12_buffer;

    /// A position or stride slip here is a sheared or garbled stream; every byte must land where
    /// NV12 says, with libwebrtc's own strides.
    #[test]
    fn should_copy_every_plane_byte_to_its_place() {
        let (w, h) = (6usize, 4usize);
        let src: Vec<u8> = (0..w * h + w * h / 2).map(|i| i as u8).collect();
        let buf = nv12_buffer(&src, w as u32, h as u32);
        let (sy, suv) = buf.strides();
        let (y, uv) = buf.data();
        for row in 0..h {
            assert_eq!(&y[row * sy as usize..row * sy as usize + w], &src[row * w..row * w + w]);
        }
        for row in 0..h / 2 {
            let at = w * h + row * w;
            assert_eq!(&uv[row * suv as usize..row * suv as usize + w], &src[at..at + w]);
        }
    }
}
