//! macOS screen capture: ScreenCaptureKit straight into livekit (MSC-01).
//!
//! ScreenCaptureKit delivers each frame as an IOSurface-backed NV12 `CVPixelBuffer`. It goes to
//! livekit as a native buffer, without a copy, and libwebrtc's VideoToolbox backend encodes it.
//! Unlike Windows there is no encoder of ours and no pump thread: ScreenCaptureKit calls us on its
//! own queue at the configured rate, and a frame libwebrtc drops is a raw one, so nothing downstream
//! is left referencing it.

use std::mem::ManuallyDrop;
use std::sync::{Arc, Mutex};
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
    filter: SCContentFilter,
    pixel_size: (u32, u32),
    label: String,
}

impl Source {
    pub fn find(target: Target) -> Result<Self> {
        // Connects this process to the window server. A window filter asserts that connection
        // exists (CGS_REQUIRE_INIT) and aborts the helper without it: we are a command-line process,
        // so nothing has made one. A display filter happens not to need it.
        let _ = apple_cf::cg::Display::main();
        // Also the first call that needs the Screen Recording permission; refused, it errors here.
        let content = SCShareableContent::get()
            .map_err(|e| anyhow!("listing shareable content: {e}"))?;
        let (builder, label) = match target {
            Target::MainDisplay | Target::Display(_) => {
                let displays = content.displays();
                let display = match target {
                    Target::Display(id) => displays.iter().find(|d| d.display_id() == id),
                    _ => displays
                        .iter()
                        .find(|d| d.frame().origin.x == 0.0 && d.frame().origin.y == 0.0)
                        .or_else(|| displays.first()),
                }
                .with_context(|| format!("no display matches {target:?}"))?;
                (SCContentFilter::create().with_display(display), format!("display {}", display.display_id()))
            }
            Target::Window(id) => {
                let windows = content.windows();
                let window = windows
                    .iter()
                    .find(|w| w.window_id() == id)
                    .with_context(|| format!("no window matches {target:?}"))?;
                (SCContentFilter::create().with_window(window), format!("window {id}"))
            }
        };
        let filter = builder
            .build()
            .map_err(|e| anyhow!("building the content filter: {e}"))?;
        // ScreenCaptureKit reports displays and windows in points. The real pixel size comes from
        // the filter: twice the points on a Retina panel, and capturing at the point size would
        // halve the picture.
        let info = SCShareableContentInfo::for_filter(&filter)
            .with_context(|| format!("no content info for {label}"))?;
        let pixel_size = info.pixel_size();
        if pixel_size.0 < 2 || pixel_size.1 < 2 {
            anyhow::bail!("{label} reports an empty size");
        }
        Ok(Self { filter, pixel_size, label })
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

/// A running capture. Dropping it stops the stream.
pub struct MacCapture {
    stream: SCStream,
}

impl MacCapture {
    /// Starts capturing `source` scaled to `canvas` at up to `fps`, handing every new frame to
    /// `video`. `first_frame` runs once, on the first frame handed over; `ended` runs once, if the
    /// stream stops without being asked to.
    pub fn start(
        source: &Source,
        canvas: (u32, u32),
        fps: u32,
        video: NativeVideoSource,
        first_frame: impl FnOnce() + Send + 'static,
        ended: impl FnOnce(Ended) + Send + 'static,
    ) -> Result<Self> {
        let config = SCStreamConfiguration::new()
            .with_width(canvas.0)
            .with_height(canvas.1)
            .with_pixel_format(PixelFormat::YCbCr_420v)
            .with_fps(fps)
            .with_shows_cursor(true)
            // A window resized mid-share is drawn into the same canvas, scaled and letterboxed,
            // rather than cropped. Following its new size is MSC-02.
            .with_scales_to_fit(true)
            // Apple's recommended minimum for a smooth stream: enough buffers that a frame still
            // being encoded is never the one ScreenCaptureKit writes the next into.
            .with_queue_depth(5);

        let first_frame: Arc<Mutex<Option<FirstFrame>>> = Arc::new(Mutex::new(Some(Box::new(first_frame))));
        let delegate = StopWatch {
            ended: Mutex::new(Some(Box::new(ended))),
            first_frame: first_frame.clone(),
        };
        let mut stream = SCStream::new_with_delegate(&source.filter, &config, delegate)
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
        stream
            .start_capture()
            .map_err(|e| anyhow!("starting the capture stream: {e}"))?;
        log::info!("ScreenCaptureKit capturing {} at {}x{}@{fps}", source.label, canvas.0, canvas.1);
        Ok(Self { stream })
    }
}

impl Drop for MacCapture {
    fn drop(&mut self) {
        if let Err(e) = self.stream.stop_capture() {
            log::warn!("stopping the capture stream: {e}");
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
    ended: Mutex<Option<EndedFn>>,
    first_frame: Arc<Mutex<Option<FirstFrame>>>,
}

impl SCStreamDelegateTrait for StopWatch {
    fn did_stop_with_error(&self, error: SCError) {
        // The source vanishing and the user pressing the system's "stop sharing" both end the share
        // the way closing a browser share's source does; everything else is a failure.
        let gone = matches!(
            error.stream_error_code(),
            Some(SCStreamErrorCode::NoCaptureSource | SCStreamErrorCode::UserStopped)
        );
        let why = if gone { Ended::Gone } else { Ended::Failed(format!("capture stream stopped: {error}")) };
        // The reason first, then the first-frame callback: whoever learns that no frame is coming
        // reads the reason next, and it must already be there.
        if let Some(ended) = self.ended.lock().ok().and_then(|mut e| e.take()) {
            ended(why);
        }
        drop(self.first_frame.lock().ok().and_then(|mut f| f.take()));
    }
}
