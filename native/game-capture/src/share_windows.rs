//! Windows: what runs behind a share, the encode thread (WGC captured; our MF encoder, or sharp's
//! libwebrtc VP9), and how its start, readiness and end reach `run`. macOS has the same surface
//! (share_mac.rs), so `run` holds no platform code of its own.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use livekit::track::LocalVideoTrack;
use livekit::webrtc::video_source::native::NativeVideoSource;
use mqvi_game_capture::capture::ScreenCapture;
use mqvi_game_capture::mf_encoder::describe_hardware_encoders;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::{delivery_watch, encoded_pump, is_source_gone, sharp_pump, Codec, DevHarness, Died, StreamPlan, VideoConfig};

/// The encode thread behind a running share, and the watch on what it delivers.
pub(crate) struct PlatformShare {
    /// None on the synthetic path, which the tokio frame pump draws instead.
    pump: Option<std::thread::JoinHandle<()>>,
    delivery: Option<JoinHandle<()>>,
    sharp: bool,
    use_mf: bool,
    /// Nothing reports a death on the synthetic path. Holding the sender keeps the stream loop
    /// waiting on stop and room events: a closed channel reads as an encoder that died.
    _synthetic_died: Option<mpsc::UnboundedSender<Died>>,
}

impl PlatformShare {
    pub(crate) fn start(
        plan: &StreamPlan,
        capture: Option<ScreenCapture>,
        video: NativeVideoSource,
        _track: &LocalVideoTrack,
        stop: Arc<AtomicBool>,
        ready_tx: oneshot::Sender<String>,
        died_tx: mpsc::UnboundedSender<Died>,
    ) -> Self {
        let (pump, synthetic_died) = if plan.use_mf || plan.sharp {
            let cfg = VideoConfig {
                width: plan.width,
                height: plan.height,
                fps: plan.fps,
                hevc: matches!(plan.codec, Codec::H265),
                max: plan.max,
            };
            (Some(start_pump(plan.sharp, cfg, capture, video, stop, ready_tx, died_tx)), None)
        } else {
            (None, Some(died_tx))
        };
        Self { pump, delivery: None, sharp: plan.sharp, use_mf: plan.use_mf, _synthetic_died: synthetic_died }
    }

    /// The pump owns `ready`: when it ends before a frame, dropping `ready` is what says so.
    pub(crate) fn ends_before_ready(&self) -> bool {
        false
    }

    /// Smooth only: its frames are already encoded, so a frame libwebrtc drops costs viewers a
    /// freeze until the next keyframe, and nothing but these counters shows it.
    pub(crate) fn streaming(&mut self, track: &LocalVideoTrack) {
        if self.use_mf {
            self.delivery = Some(tokio::spawn(delivery_watch::watch(track.clone())));
        }
    }

    /// Joining matters: the pump owns the capture, so this is where the WGC session gets closed.
    pub(crate) fn shutdown(&mut self) {
        if let Some(w) = self.delivery.take() {
            w.abort();
        }
        log::info!("shutdown: joining encode thread");
        if let Some(t) = self.pump.take() {
            let _ = t.join();
        }
    }

    /// For a share that produced nothing: what was there to encode it. Only the hardware path has
    /// encoders to describe; sharp's encoder is libwebrtc's own.
    pub(crate) fn encoders(&self) -> String {
        if self.sharp {
            sharp_pump::ENCODER_NAME.to_string()
        } else {
            describe_hardware_encoders()
        }
    }
}

/// Capture and MF encoding make blocking calls, so they run on a dedicated OS thread (smooth and
/// sharp alike). The thread owns `died_tx`: if it ends without sending, the channel closes and the
/// stream loop treats that as the encoder dying.
fn start_pump(
    sharp: bool,
    cfg: VideoConfig,
    capture: Option<ScreenCapture>,
    src: NativeVideoSource,
    stop: Arc<AtomicBool>,
    ready_tx: oneshot::Sender<String>,
    died_tx: mpsc::UnboundedSender<Died>,
) -> std::thread::JoinHandle<()> {
    let dev = DevHarness::from_env();
    if dev.same_ms_every > 0 || dev.ignore_keyframe_requests || dev.one_encoder_session {
        log::warn!(
            "dev harness on: same-ms pair every {} frames, ignore keyframe requests {}, one encoder session {}",
            dev.same_ms_every,
            dev.ignore_keyframe_requests,
            dev.one_encoder_session
        );
    }
    std::thread::spawn(move || {
        let result = match (sharp, capture) {
            (true, Some(cap)) => sharp_pump::sharp_pump(src, cfg, cap, stop, ready_tx),
            (_, capture) => encoded_pump(src, cfg, capture, stop, ready_tx, dev),
        };
        if let Err(e) = result {
            // Bare, with no prefix of its own: the error the app finally reports embeds this
            // same text, so an identical opening lets the reporter fold the two into one line
            // instead of spending its length budget saying it twice.
            log::error!("{e:#}");
            let _ = died_tx.send((format!("{e:#}"), is_source_gone(&e)));
        }
    })
}
