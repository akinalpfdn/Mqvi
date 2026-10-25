//! macOS: what runs behind a share, ScreenCaptureKit into libwebrtc's VideoToolbox backend, and
//! how its start, readiness and end reach `run`. Windows has the same surface (share_windows.rs),
//! so `run` holds no platform code of its own.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use livekit::track::LocalVideoTrack;
use livekit::webrtc::video_source::native::NativeVideoSource;
use mqvi_game_capture::mac_capture;
use mqvi_game_capture::source::SourceGone;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::{canvas_for, encoder_watch, Died, StreamPlan};

/// The capture behind a running share, and the checks watching it.
pub(crate) struct PlatformShare {
    /// None with nothing to capture (the synthetic source), or when the capture failed to start.
    stream: Option<mac_capture::MacCapture>,
    encode_check: Option<JoinHandle<()>>,
    encoder: Option<JoinHandle<()>>,
    captures: bool,
    /// Held so the channel stays open with nothing to capture: closed, it reads as an encoder that
    /// died.
    _died: mpsc::UnboundedSender<Died>,
}

impl PlatformShare {
    /// ScreenCaptureKit runs on its own queue; there is no thread of ours to start or join. Ready
    /// waits for proof that VideoToolbox, in hardware, encoded the first frame.
    pub(crate) fn start(
        plan: &StreamPlan,
        capture: Option<mac_capture::Source>,
        video: NativeVideoSource,
        track: &LocalVideoTrack,
        _stop: Arc<AtomicBool>,
        ready_tx: oneshot::Sender<String>,
        died_tx: mpsc::UnboundedSender<Died>,
    ) -> Self {
        let Some(src) = capture else {
            return Self { stream: None, encode_check: None, encoder: None, captures: false, _died: died_tx };
        };
        let (frame_tx, frame_rx) = oneshot::channel::<()>();
        let check = tokio::spawn(confirm_hardware_encode(track.clone(), frame_rx, ready_tx, died_tx.clone()));
        let canvas = (plan.width, plan.height);
        let stream = match start_mac_capture(&src, canvas, plan.fps, plan.max, video, frame_tx, died_tx.clone()) {
            Ok(stream) => Some(stream),
            // The track is already published. Reported on the died channel, the failure goes
            // through the shutdown and closes the room; ending here would leave viewers a ghost
            // share until the SFU timed us out.
            Err(e) => {
                log::error!("{e:#}");
                let _ = died_tx.send((format!("{e:#}"), false));
                None
            }
        };
        Self { stream, encode_check: Some(check), encoder: None, captures: true, _died: died_tx }
    }

    /// Whether the capture can end before `ready`: it does not own `ready` here, as the Windows
    /// pump does, so its end does not drop it.
    pub(crate) fn ends_before_ready(&self) -> bool {
        self.captures
    }

    /// The mac asks libwebrtc for VideoToolbox; only the sender's stats show whether it got it.
    pub(crate) fn streaming(&mut self, track: &LocalVideoTrack) {
        if self.captures {
            self.encoder = Some(tokio::spawn(encoder_watch::watch(track.clone())));
        }
    }

    pub(crate) fn shutdown(&mut self) {
        for task in [self.encoder.take(), self.encode_check.take()].into_iter().flatten() {
            task.abort();
        }
        // Dropping the stream stops ScreenCaptureKit; no frame reaches the track after this.
        log::info!("shutdown: stopping capture");
        drop(self.stream.take());
    }

    /// For a share that produced nothing: what was there to encode it.
    pub(crate) fn encoders(&self) -> String {
        "VideoToolbox (libwebrtc)".to_string()
    }
}

/// Starts ScreenCaptureKit into `video`. `first_frame` fires on the first frame handed over, and a
/// share that ends by itself reports on the same died channel the Windows pump uses.
fn start_mac_capture(
    src: &mac_capture::Source,
    canvas: (u32, u32),
    fps: u32,
    max: (u32, u32),
    video: NativeVideoSource,
    first_frame: oneshot::Sender<()>,
    died_tx: mpsc::UnboundedSender<Died>,
) -> Result<mac_capture::MacCapture> {
    mac_capture::MacCapture::start(
        src,
        canvas,
        fps,
        video,
        // A resized source streams at what the quality cap allows for its new size, as at start.
        move |(w, h)| canvas_for(w, h, max),
        move || {
            let _ = first_frame.send(());
        },
        move |ended| {
            let report = match ended {
                mac_capture::Ended::Gone => (SourceGone.to_string(), true),
                mac_capture::Ended::Failed(why) => {
                    log::error!("{why}");
                    (why, false)
                }
            };
            let _ = died_tx.send(report);
        },
    )
}

/// How long VideoToolbox has, once the transport is connected, to show an encoded frame. Counted
/// from the connection, not from publish: libwebrtc encodes nothing before it, and the connection
/// alone took about 3 s on a good network (measured) and can take longer over TURN/TLS or a long
/// RTT. A transport that never connects is bounded by the app's own ready timeout (15 s).
const ENCODE_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);

/// Announces ready only once the sender's stats show a frame encoded in hardware. Asking libwebrtc
/// for VideoToolbox is not getting it: it can fall back to a software H.264 encoder without saying
/// so, and a software "Smooth Video" is the CPU-bound share this engine exists to avoid. The app
/// then falls back to "Sharp Video", whose software VP9 does that job better.
async fn confirm_hardware_encode(
    track: LocalVideoTrack,
    first_frame: oneshot::Receiver<()>,
    ready: oneshot::Sender<String>,
    died: mpsc::UnboundedSender<Died>,
) {
    // The capture ended before a frame: it has reported why, and dropping `ready` says none came.
    if first_frame.await.is_err() {
        return;
    }
    use encoder_watch::EncodeCheck;
    let first_frame_at = std::time::Instant::now();
    let mut connected_at = None;
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Absent briefly while the sender comes up; nothing is decided on a missing reading.
        let Ok(stats) = track.get_stats().await else { continue };
        match encoder_watch::check_encode(&stats, connected_at, std::time::Instant::now(), ENCODE_CONFIRM_TIMEOUT) {
            EncodeCheck::Hardware(name) => {
                let _ = ready.send(name);
                return;
            }
            EncodeCheck::Software(name) => {
                let _ = died.send((format!("libwebrtc encoded with {name}, which is not a hardware encoder"), false));
                return;
            }
            EncodeCheck::TimedOut => {
                let secs = ENCODE_CONFIRM_TIMEOUT.as_secs();
                let _ = died.send((format!("connected, but no frame encoded within {secs}s"), false));
                return;
            }
            EncodeCheck::Waiting(since) => {
                // Once: how long the connection took, which is what the encode budget waits out.
                if let (None, Some(at)) = (connected_at, since) {
                    log::info!("transport connected {:.1}s after the first frame", at.duration_since(first_frame_at).as_secs_f64());
                }
                connected_at = since;
            }
        }
    }
}
