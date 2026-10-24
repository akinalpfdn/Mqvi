//! macOS screen capture: ScreenCaptureKit straight into livekit (MSC-01).
//!
//! ScreenCaptureKit delivers each frame as an IOSurface-backed NV12 `CVPixelBuffer`. It goes to
//! livekit as a native buffer, without a copy, and libwebrtc's VideoToolbox backend encodes it.
//! Unlike Windows there is no encoder of ours and no pump thread: ScreenCaptureKit calls us on its
//! own queue at the configured rate, and a frame libwebrtc drops is a raw one, so nothing downstream
//! is left referencing it.
//!
//! What ScreenCaptureKit does not report, a follower thread polls for: the source's size, so the
//! stream follows a resized window, and whether the source still exists at all.

use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use livekit::webrtc::video_frame::native::NativeBuffer;
use livekit::webrtc::video_frame::{VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use screencapturekit::cm::SCFrameStatus;
use screencapturekit::cv::CVPixelBuffer;
use screencapturekit::error::SCStreamErrorCode;
use screencapturekit::prelude::*;
use screencapturekit::shareable_content::SCShareableContentInfo;

/// What to capture.
#[derive(Clone, Copy, Debug)]
pub enum Target {
    /// The display whose origin is (0,0): the main one.
    MainDisplay,
    /// A `CGDirectDisplayID`.
    Display(u32),
    /// A `CGWindowID`: one window, wherever it is and whatever covers it.
    Window(u32),
}

/// How a running capture ended without being asked to.
#[derive(Debug)]
pub enum Ended {
    /// The source went away, or the user stopped the share from the system's own control.
    Gone,
    /// Anything else: the cause as text.
    Failed(String),
}

/// A source found and measured, not yet capturing. Sizing the stream needs the source's size
/// before anything is published; capturing starts once the track exists.
pub struct Source {
    target: Target,
    filter: SCContentFilter,
    pixel_size: (u32, u32),
    label: String,
}

impl Source {
    pub fn find(target: Target) -> Result<Self> {
        within("the content listing", move || {
            // Connects this process to the window server. A window filter asserts that connection
            // exists (CGS_REQUIRE_INIT) and aborts the helper without it: we are a command-line
            // process, so nothing has made one. A display filter happens not to need it.
            let _ = apple_cf::cg::Display::main();
            let Located { filter, label, .. } =
                locate(target)?.with_context(|| format!("no display or window matches {target:?}"))?;
            let pixel_size = pixel_size(&filter, &label)?;
            Ok(Self { target, filter, pixel_size, label })
        })
    }

    pub fn width(&self) -> u32 {
        self.pixel_size.0
    }

    pub fn height(&self) -> u32 {
        self.pixel_size.1
    }

    pub fn label(&self) -> &str {
        &self.label
    }
}

/// How long ScreenCaptureKit gets to answer a listing or a start. Its service (replayd) can wedge,
/// measured 2026-10-24: every request then queues forever, and a helper waiting on one is killed by
/// the app after 15 s without leaving the room. Failing here instead ends the share cleanly, with
/// a reason.
const SCK_ANSWER_LIMIT: Duration = Duration::from_secs(5);

/// Runs a ScreenCaptureKit call on its own thread and gives up after `SCK_ANSWER_LIMIT`. A call
/// that never returns is left behind; the process ends soon after.
pub(crate) fn within<T: Send + 'static>(what: &str, f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(SCK_ANSWER_LIMIT).map_err(|_| {
        anyhow!(
            "ScreenCaptureKit did not answer {what} within {}s; the system capture service (replayd) may be stuck",
            SCK_ANSWER_LIMIT.as_secs()
        )
    })?
}

/// Where a source was found.
struct Located {
    filter: SCContentFilter,
    label: String,
    /// False for a minimised window (or one on another Space): it exists, but what its frame says
    /// then is not a size to stream at.
    on_screen: bool,
    /// The window's or display's frame in points, as ScreenCaptureKit lists it.
    frame_pt: (f64, f64),
}

/// `target` if it still exists, or None. Off-screen windows are included: a minimised window has
/// not gone anywhere.
fn locate(target: Target) -> Result<Option<Located>> {
    // Also the first call that needs the Screen Recording permission; refused, it errors here.
    let content = SCShareableContent::get().map_err(|e| anyhow!("listing shareable content: {e}"))?;
    let found = match target {
        Target::MainDisplay | Target::Display(_) => {
            let displays = content.displays();
            let display = match target {
                Target::Display(id) => displays.iter().find(|d| d.display_id() == id),
                _ => displays
                    .iter()
                    .find(|d| d.frame().origin.x == 0.0 && d.frame().origin.y == 0.0)
                    .or_else(|| displays.first()),
            };
            display.map(|d| {
                let size = d.frame().size;
                (SCContentFilter::create().with_display(d), format!("display {}", d.display_id()), true, (size.width, size.height))
            })
        }
        Target::Window(id) => content
            .windows()
            .iter()
            .find(|w| w.window_id() == id)
            .map(|w| {
                let size = w.frame().size;
                (SCContentFilter::create().with_window(w), format!("window {id}"), w.is_on_screen(), (size.width, size.height))
            }),
    };
    match found {
        None => Ok(None),
        Some((builder, label, on_screen, frame_pt)) => {
            let filter = builder.build().map_err(|e| anyhow!("building the content filter for {label}: {e}"))?;
            Ok(Some(Located { filter, label, on_screen, frame_pt }))
        }
    }
}

/// The source's real size in pixels. ScreenCaptureKit reports displays and windows in points; the
/// filter's content info has the scale, twice the points on a Retina panel, and capturing at the
/// point size would halve the picture.
fn pixel_size(filter: &SCContentFilter, label: &str) -> Result<(u32, u32)> {
    let info = SCShareableContentInfo::for_filter(filter).with_context(|| format!("no content info for {label}"))?;
    let size = info.pixel_size();
    if size.0 < 2 || size.1 < 2 {
        anyhow::bail!("{label} reports an empty size");
    }
    Ok(size)
}

/// What one look at the source finds.
enum Reading {
    Gone,
    /// Exists, but off screen: a minimised window reports its shrunken frame mid-animation, and
    /// following that would cut the stream to a thumbnail and back, a keyframe each way.
    Hidden,
    Size((u32, u32)),
}

fn measure(target: Target, last_seen: &mut String) -> Result<Reading> {
    let Some(l) = locate(target)? else { return Ok(Reading::Gone) };
    let px = pixel_size(&l.filter, &l.label).ok();
    // What the source looks like from here, on change only (RUST_LOG=mqvi_game_capture=debug).
    let seen = format!("on screen {}, frame {:.0}x{:.0} pt, content {:?} px", l.on_screen, l.frame_pt.0, l.frame_pt.1, px);
    if seen != *last_seen {
        log::debug!("{}: {seen}", l.label);
        *last_seen = seen;
    }
    if !l.on_screen {
        return Ok(Reading::Hidden);
    }
    px.map(Reading::Size).with_context(|| format!("no pixel size for {}", l.label))
}

/// The stream settings for a canvas. One place, so a reconfigured stream keeps every other setting.
fn stream_config(canvas: (u32, u32), fps: u32) -> SCStreamConfiguration {
    SCStreamConfiguration::new()
        .with_width(canvas.0)
        .with_height(canvas.1)
        .with_pixel_format(PixelFormat::YCbCr_420v)
        .with_fps(fps)
        .with_shows_cursor(true)
        // Between a resize and the follower catching up, the source is scaled into the old canvas
        // and letterboxed rather than cropped.
        .with_scales_to_fit(true)
        // Apple's recommended minimum for a smooth stream: enough buffers that a frame still
        // being encoded is never the one ScreenCaptureKit writes the next into.
        .with_queue_depth(5)
}

/// How often the follower looks at the source.
const FOLLOW_INTERVAL: Duration = Duration::from_millis(500);
/// How long the source must hold a larger size before the stream follows. Without this, dragging a
/// window's edge would reconfigure the stream on every poll. The same settle as Windows.
const RESIZE_SETTLE: Duration = Duration::from_millis(500);
/// How long it must hold a smaller one. Longer on purpose: Mission Control shrinks every window to
/// a thumbnail with no sign that sets it apart from a real resize (on screen, frame, content rect
/// and frame status all read as a resize; measured 2026-10-24), and following it left the stream
/// at thumbnail size for a blurry second after Mission Control closed. Waiting costs a real shrink
/// only a few seconds of letterboxing in a canvas larger than needed.
const SHRINK_SETTLE: Duration = Duration::from_secs(3);
/// Consecutive polls that must not find the source before it counts as gone: one missing reading
/// is not worth ending a share over.
const GONE_AFTER_MISSES: u32 = 2;

/// Decides when the stream follows the source's size: only once a new size has held for its settle
/// (`RESIZE_SETTLE` to grow, `SHRINK_SETTLE` to shrink), never while it is still changing.
#[derive(Debug)]
pub(crate) struct SizeFollower {
    applied: (u32, u32),
    wanted: Option<((u32, u32), Instant)>,
}

impl SizeFollower {
    pub(crate) fn new(applied: (u32, u32)) -> Self {
        Self { applied, wanted: None }
    }

    /// The canvas to switch to now, if any. `want` is the canvas the source's current size calls for.
    pub(crate) fn observe(&mut self, want: (u32, u32), now: Instant) -> Option<(u32, u32)> {
        if want == self.applied {
            self.wanted = None;
            return None;
        }
        let settle = if area(want) < area(self.applied) { SHRINK_SETTLE } else { RESIZE_SETTLE };
        match self.wanted {
            Some((w, since)) if w == want => (now.duration_since(since) >= settle).then_some(want),
            _ => {
                self.wanted = Some((want, now));
                None
            }
        }
    }

    /// The stream now runs at `canvas`.
    pub(crate) fn applied(&mut self, canvas: (u32, u32)) {
        self.applied = canvas;
        self.wanted = None;
    }

    /// The stream refused `canvas`: wait for another full settle before trying again.
    pub(crate) fn refused(&mut self) {
        self.wanted = None;
    }
}

fn area((w, h): (u32, u32)) -> u64 {
    u64::from(w) * u64::from(h)
}

/// Shared by the stream's delegate and the follower: whichever learns first that the share is over
/// reports it, once, and releases a caller still waiting for the first frame.
struct Ending {
    ended: Mutex<Option<EndedFn>>,
    first_frame: Arc<Mutex<Option<FirstFrame>>>,
    /// ScreenCaptureKit stopped the stream itself. Stopping it again then waits for a completion
    /// that never comes (measured: the helper hung on the way out and was killed, room left open).
    system_stopped: AtomicBool,
}

impl Ending {
    fn report(&self, why: Ended) {
        // The reason first, then the first-frame callback: whoever learns that no frame is coming
        // reads the reason next, and it must already be there.
        if let Some(ended) = self.ended.lock().ok().and_then(|mut e| e.take()) {
            ended(why);
        }
        drop(self.first_frame.lock().ok().and_then(|mut f| f.take()));
    }
}

/// A running capture. Dropping it stops the follower, then the stream.
pub struct MacCapture {
    stream: SCStream,
    ending: Arc<Ending>,
    stop_follower: Option<mpsc::Sender<()>>,
    follower: Option<JoinHandle<()>>,
}

impl MacCapture {
    /// Starts capturing `source` scaled to `canvas` at up to `fps`, handing every new frame to
    /// `video`. `fit` turns a source size into the canvas the stream should use, for when the source
    /// is resized. `first_frame` runs once, on the first frame handed over; `ended` runs once, if
    /// the share ends without being asked to.
    pub fn start(
        source: &Source,
        canvas: (u32, u32),
        fps: u32,
        video: NativeVideoSource,
        fit: impl Fn((u32, u32)) -> (u32, u32) + Send + 'static,
        first_frame: impl FnOnce() + Send + 'static,
        ended: impl FnOnce(Ended) + Send + 'static,
    ) -> Result<Self> {
        let first_frame: Arc<Mutex<Option<FirstFrame>>> = Arc::new(Mutex::new(Some(Box::new(first_frame))));
        let ending = Arc::new(Ending {
            ended: Mutex::new(Some(Box::new(ended))),
            first_frame: first_frame.clone(),
            system_stopped: AtomicBool::new(false),
        });
        let delegate = StopWatch { ending: ending.clone() };
        let mut stream = SCStream::new_with_delegate(&source.filter, &stream_config(canvas, fps), delegate)
            .map_err(|e| anyhow!("creating the capture stream: {e}"))?;
        let frames = FrameHandoff {
            video,
            t0: Instant::now(),
            first_frame,
            counts: Mutex::new(Counts::new()),
        };
        stream
            .add_output_handler(frames, SCStreamOutputType::Screen)
            .map_err(|e| anyhow!("adding the frame handler: {e}"))?;
        let starting = stream.clone();
        within("the capture start", move || {
            starting.start_capture().map_err(|e| anyhow!("starting the capture stream: {e}"))
        })?;
        log::info!("ScreenCaptureKit capturing {} at {}x{}@{fps}", source.label, canvas.0, canvas.1);

        let (stop_tx, stop_rx) = mpsc::channel();
        let follower = Follower {
            target: source.target,
            label: source.label.clone(),
            stream: stream.clone(),
            fps,
            size: SizeFollower::new(canvas),
            fit: Box::new(fit),
            ending: ending.clone(),
        };
        let follower = std::thread::Builder::new()
            .name("mqvi-sck-follow".into())
            .spawn(move || follower.run(stop_rx))
            .context("starting the capture follower")?;
        Ok(Self { stream, ending, stop_follower: Some(stop_tx), follower: Some(follower) })
    }
}

/// How long the way out waits on any one ScreenCaptureKit call. The process ends right after, and
/// a share stuck on its way out is worse than an abandoned call: the app kills a helper that does
/// not exit within 3 s, and a killed helper never leaves the room.
pub(crate) const SHUTDOWN_STEP_LIMIT: Duration = Duration::from_secs(1);

/// Runs `f` on its own thread and waits at most `limit` for it.
pub(crate) fn bounded(what: &str, limit: Duration, f: impl FnOnce() + Send + 'static) {
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        f();
        let _ = done_tx.send(());
    });
    if done_rx.recv_timeout(limit).is_err() {
        log::warn!("{what} did not finish within {limit:?}; leaving it behind");
    }
}

impl Drop for MacCapture {
    fn drop(&mut self) {
        // The follower first, so it can neither reconfigure a stream being stopped nor report a
        // source "gone" that we are only letting go of. Dropping the sender wakes it, unless it is
        // inside a listing ScreenCaptureKit is slow to answer.
        drop(self.stop_follower.take());
        if let Some(f) = self.follower.take() {
            bounded("the capture follower", SHUTDOWN_STEP_LIMIT, move || {
                let _ = f.join();
            });
        }
        if self.ending.system_stopped.load(Ordering::Acquire) {
            return;
        }
        let stream = self.stream.clone();
        bounded("stopping the capture stream", SHUTDOWN_STEP_LIMIT, move || {
            if let Err(e) = stream.stop_capture() {
                log::warn!("stopping the capture stream: {e}");
            }
        });
    }
}

/// Polls the source for what ScreenCaptureKit does not report: its size, and whether it still
/// exists. A window closing does not reliably stop the stream on every macOS release; without this
/// the share would sit frozen on its last frame.
struct Follower {
    target: Target,
    label: String,
    stream: SCStream,
    fps: u32,
    size: SizeFollower,
    fit: Box<dyn Fn((u32, u32)) -> (u32, u32) + Send>,
    ending: Arc<Ending>,
}

impl Follower {
    fn run(mut self, stop: mpsc::Receiver<()>) {
        let mut misses = 0u32;
        let mut failing = false;
        let mut last_seen = String::new();
        loop {
            match stop.recv_timeout(FOLLOW_INTERVAL) {
                Err(RecvTimeoutError::Timeout) => {}
                _ => return,
            }
            match measure(self.target, &mut last_seen) {
                Ok(Reading::Gone) => {
                    misses += 1;
                    if misses >= GONE_AFTER_MISSES {
                        log::info!("{} is gone", self.label);
                        self.ending.report(Ended::Gone);
                        return;
                    }
                }
                // It exists, so not a miss; its size is left alone until it is back on screen.
                Ok(Reading::Hidden) => misses = 0,
                Ok(Reading::Size(px)) => {
                    misses = 0;
                    failing = false;
                    let want = (self.fit)(px);
                    if let Some(next) = self.size.observe(want, Instant::now()) {
                        match self.stream.update_configuration(&stream_config(next, self.fps)) {
                            Ok(()) => {
                                log::info!("stream follows {} at {}x{} → {}x{}", self.label, px.0, px.1, next.0, next.1);
                                self.size.applied(next);
                            }
                            Err(e) => {
                                log::warn!("could not resize the stream to {}x{}: {e}", next.0, next.1);
                                self.size.refused();
                            }
                        }
                    }
                }
                // Not a verdict: if the capture itself is broken, the stream reports it. Said once.
                Err(e) => {
                    if !failing {
                        log::warn!("could not measure {}: {e:#}", self.label);
                    }
                    failing = true;
                }
            }
        }
    }
}

/// Frames ScreenCaptureKit delivered in the last second, by status — logged once a second, so a
/// stall or a static screen is visible in the log rather than guessed at.
struct Counts {
    since: Instant,
    complete: u32,
    idle: u32,
    other: u32,
}

impl Counts {
    fn new() -> Self {
        Self { since: Instant::now(), complete: 0, idle: 0, other: 0 }
    }
}

type FirstFrame = Box<dyn FnOnce() + Send>;
type EndedFn = Box<dyn FnOnce(Ended) + Send>;

struct FrameHandoff {
    video: NativeVideoSource,
    t0: Instant,
    /// Shared with the delegate, which drops it when the stream ends: a caller waiting for the first
    /// frame must hear that none is coming, as it does when the Windows pump thread exits.
    first_frame: Arc<Mutex<Option<FirstFrame>>>,
    counts: Mutex<Counts>,
}

impl SCStreamOutputTrait for FrameHandoff {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if !matches!(of_type, SCStreamOutputType::Screen) {
            return;
        }
        // Only a complete frame carries new pixels. Idle means nothing changed since the last one;
        // ScreenCaptureKit, like WGC, only delivers on change.
        let status = sample.frame_status();
        let pixels = match status {
            Some(SCFrameStatus::Complete) => sample.pixel_buffer(),
            _ => None,
        };
        if let Some(pixels) = &pixels {
            // Never 0: livekit reads a zero timestamp as "stamp it with the wall clock", which would
            // put one frame on a different clock from the rest.
            let timestamp_us = (self.t0.elapsed().as_micros() as i64).max(1);
            hand_over(&self.video, pixels, timestamp_us);
            if let Some(first) = self.first_frame.lock().ok().and_then(|mut f| f.take()) {
                // What ScreenCaptureKit really delivers, once: the configured size is a request.
                let fourcc = pixels.pixel_format().to_be_bytes();
                log::info!(
                    "first frame: {}x{} '{}'",
                    pixels.width(),
                    pixels.height(),
                    String::from_utf8_lossy(&fourcc)
                );
                first();
            }
        }

        let Ok(mut c) = self.counts.lock() else { return };
        match (status, pixels.is_some()) {
            (_, true) => c.complete += 1,
            (Some(SCFrameStatus::Idle), _) => c.idle += 1,
            _ => c.other += 1,
        }
        if c.since.elapsed() >= Duration::from_secs(1) {
            let secs = c.since.elapsed().as_secs_f64();
            log::info!(
                "capture: {:.1} fps new, {:.1} idle, {:.1} other",
                c.complete as f64 / secs,
                c.idle as f64 / secs,
                c.other as f64 / secs
            );
            *c = Counts::new();
        }
    }
}

/// Hands one frame to livekit without copying it.
fn hand_over(video: &NativeVideoSource, pixels: &CVPixelBuffer, timestamp_us: i64) {
    // A retain of our own, to give away: livekit's wrapper takes its own retain and then releases
    // the reference it was handed (vendor/webrtc-sys/src/objc_video_frame_buffer.mm:30).
    let transferred = ManuallyDrop::new(pixels.clone());
    // SAFETY: `transferred` is a live CVPixelBufferRef holding the +1 retain clone() just took, and
    // ManuallyDrop keeps this side from releasing it. from_cv_pixel_buffer consumes exactly one
    // reference, so that retain is the one it releases, and `pixels` keeps its own.
    let buffer = unsafe { NativeBuffer::from_cv_pixel_buffer(transferred.as_ptr()) };
    video.capture_frame(&VideoFrame {
        rotation: VideoRotation::VideoRotation0,
        timestamp_us,
        frame_metadata: None,
        buffer,
    });
}

struct StopWatch {
    ending: Arc<Ending>,
}

impl SCStreamDelegateTrait for StopWatch {
    fn did_stop_with_error(&self, error: SCError) {
        // The source vanishing and the user pressing the system's "stop sharing" both end the share
        // the way closing a browser share's source does; everything else is a failure.
        let gone = matches!(
            error.stream_error_code(),
            Some(SCStreamErrorCode::NoCaptureSource | SCStreamErrorCode::UserStopped)
        );
        self.ending.system_stopped.store(true, Ordering::Release);
        self.ending.report(if gone { Ended::Gone } else { Ended::Failed(format!("capture stream stopped: {error}")) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: (u32, u32) = (1280, 720);
    const BIGGER: (u32, u32) = (1856, 1080);
    const SMALLER: (u32, u32) = (828, 420);

    #[test]
    fn should_give_up_on_a_shutdown_step_that_never_returns() {
        // The hang this replaces: stop_capture on a stream the system had already stopped.
        let started = Instant::now();
        bounded("a stuck call", Duration::from_millis(50), || std::thread::sleep(Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(1), "waited {:?}", started.elapsed());
    }

    #[test]
    fn should_wait_for_a_shutdown_step_that_finishes_in_time() {
        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        bounded("a quick call", Duration::from_secs(1), move || flag.store(true, Ordering::Release));
        assert!(done.load(Ordering::Acquire));
    }

    #[test]
    fn should_leave_the_stream_alone_while_the_source_keeps_its_size() {
        let mut f = SizeFollower::new(START);
        assert_eq!(f.observe(START, Instant::now()), None);
    }

    #[test]
    fn should_follow_a_larger_size_once_it_has_held_for_the_settle() {
        let t0 = Instant::now();
        let mut f = SizeFollower::new(START);
        assert_eq!(f.observe(BIGGER, t0), None, "first sight of a new size");
        assert_eq!(f.observe(BIGGER, t0 + RESIZE_SETTLE / 2), None, "not settled yet");
        assert_eq!(f.observe(BIGGER, t0 + RESIZE_SETTLE), Some(BIGGER));
    }

    #[test]
    fn should_ride_out_a_brief_shrink_like_mission_control() {
        // Mission Control: every window drops to a thumbnail for a few seconds, then comes back.
        let t0 = Instant::now();
        let mut f = SizeFollower::new(START);
        assert_eq!(f.observe(SMALLER, t0), None);
        assert_eq!(f.observe(SMALLER, t0 + RESIZE_SETTLE * 4), None, "still inside the shrink settle");
        assert_eq!(f.observe(START, t0 + RESIZE_SETTLE * 5), None, "back before it settled: no change at all");
    }

    #[test]
    fn should_follow_a_smaller_size_once_it_has_held_for_the_longer_settle() {
        let t0 = Instant::now();
        let mut f = SizeFollower::new(START);
        assert_eq!(f.observe(SMALLER, t0), None);
        assert_eq!(f.observe(SMALLER, t0 + SHRINK_SETTLE - Duration::from_millis(1)), None);
        assert_eq!(f.observe(SMALLER, t0 + SHRINK_SETTLE), Some(SMALLER));
    }

    #[test]
    fn should_not_follow_a_size_that_keeps_changing() {
        // Dragging a window's edge: a different size on every poll, never one held for the settle.
        let t0 = Instant::now();
        let mut f = SizeFollower::new(START);
        for i in 0..10u32 {
            let size = (1000 + i * 10, 600 + i * 6);
            assert_eq!(f.observe(size, t0 + RESIZE_SETTLE * i), None, "poll {i}");
        }
    }

    #[test]
    fn should_forget_a_pending_size_when_the_source_returns_to_the_applied_one() {
        let t0 = Instant::now();
        let mut f = SizeFollower::new(START);
        f.observe(BIGGER, t0);
        f.observe(START, t0 + RESIZE_SETTLE / 2);
        // Back to the bigger size: the settle starts over instead of counting from the first sight.
        assert_eq!(f.observe(BIGGER, t0 + RESIZE_SETTLE), None);
    }

    #[test]
    fn should_settle_again_before_retrying_a_refused_size() {
        let t0 = Instant::now();
        let mut f = SizeFollower::new(START);
        f.observe(BIGGER, t0);
        assert_eq!(f.observe(BIGGER, t0 + RESIZE_SETTLE), Some(BIGGER));
        f.refused();
        assert_eq!(f.observe(BIGGER, t0 + RESIZE_SETTLE), None);
        assert_eq!(f.observe(BIGGER, t0 + RESIZE_SETTLE * 2), Some(BIGGER));
    }

    #[test]
    fn should_stay_put_after_following() {
        let t0 = Instant::now();
        let mut f = SizeFollower::new(START);
        f.observe(BIGGER, t0);
        f.observe(BIGGER, t0 + RESIZE_SETTLE);
        f.applied(BIGGER);
        assert_eq!(f.observe(BIGGER, t0 + RESIZE_SETTLE * 2), None);
    }
}
