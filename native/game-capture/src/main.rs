//! mqvi-game-capture — NGC-01 spike.
//!
//! Standalone native process that publishes a video track to the server-assigned
//! LiveKit instance with E2EE. It proves the native -> LiveKit -> E2EE -> app-client
//! path end to end before any real WGC capture or NVENC encode is built on top.
//!
//! The source here is synthetic: an animated I420 test pattern. E2EE uses the room
//! passphrase returned by GenerateScreenShareToken. livekit-rust's KeyProvider derives
//! the AES-GCM frame key with PBKDF2 over the passphrase and salt "LKFrameEncryptionKey",
//! byte-for-byte identical to the JS ExternalE2EEKeyProvider our app clients use — so a
//! client that set the same passphrase decrypts and renders this pattern.
//!
//! Connection inputs (url, token, e2ee-key) come straight from the server's
//! POST /api/servers/{serverId}/voice/screen-token response {url, token, e2eePassphrase}.
//! The identity baked into that token is "{userId}_ss", the screen-share sub-participant.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use livekit::e2ee::key_provider::{KeyProvider, KeyProviderOptions};
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::track::{LocalTrack, LocalVideoTrack, TrackSource};
use livekit::webrtc::rtp_sender::VideoEncoderBackend;
#[cfg(windows)]
use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame};
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::{Room, RoomEvent, RoomOptions};
#[cfg(windows)]
use mqvi_game_capture::capture::ScreenCapture;
#[cfg(windows)]
use mqvi_game_capture::display_light;
#[cfg(target_os = "macos")]
use mqvi_game_capture::mac_capture;
#[cfg(windows)]
use mqvi_game_capture::mf_encoder::{
    describe_hardware_encoders, hardware_encoder_count, EncodedPacket, HwEncoder,
};
#[cfg(windows)]
use mqvi_game_capture::nv12;
use mqvi_game_capture::source::SourceGone;
use tokio::sync::{mpsc, oneshot};
#[cfg(windows)]
use windows::core::PCWSTR;

mod delivery_watch;
#[cfg(target_os = "macos")]
mod encoder_watch;
// The hardware pump's parts. Windows-only in a build; their tests are plain Rust and run anywhere.
#[cfg(any(windows, test))]
mod encoder_swap;
#[cfg(any(windows, test))]
mod keyframe_watch;
#[cfg(any(windows, test))]
mod pump_stats;
#[cfg(any(windows, test))]
mod pump_timing;
#[cfg(any(windows, test))]
mod rate_policy;
#[cfg(windows)]
mod sharp_pump;
#[cfg(any(windows, test))]
mod vbv_follow;
#[cfg(windows)]
use windows::Win32::Foundation::HANDLE;
#[cfg(windows)]
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority,
    AVRT_PRIORITY_HIGH,
};

/// Track names the app reads to label a share for its viewers: "Smooth Video" for the hardware
/// engine, "Sharp Video" for the HDR one. Kept in step with client/src/utils/constants.ts.
const TRACK_NAME_SMOOTH: &str = "native-game-capture";
const TRACK_NAME_SHARP: &str = "native-hdr-sharp-capture";

/// Exit code for a share whose source went away (window closed, game exited, display unplugged). The
/// app treats it as the user ending the share — no error shown — and anything else as a failure.
/// The app keeps the same number (`HELPER_EXIT_SOURCE_GONE`).
const SOURCE_GONE_EXIT: i32 = 3;

/// Whether `err` is, anywhere in its chain, the capture source going away.
fn is_source_gone(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.is::<SourceGone>())
}

/// Consecutive encode failures that mean the encoder is gone for good, not glitching (1s at 30fps).
#[cfg(windows)]
const MAX_CONSECUTIVE_ENCODE_ERRORS: u32 = 30;
/// Seconds of "accepting frames, producing nothing" that mean the same. Encoder death has three
/// shapes — erroring, silent, and hung — and this is the silent one. (Hung is bounded inside
/// HwEncoder::encode, which turns it into an error and lands on the counter above.)
#[cfg(windows)]
const MAX_SILENT_REPORTS: u32 = 3;

/// NGC-01 spike: publish a synthetic E2EE video track to a LiveKit room.
#[derive(Parser, Debug)]
#[command(name = "mqvi-game-capture", version, about)]
struct Args {
    /// Read the connection secrets as a JSON line on stdin — `{"url","token","e2eePassphrase"}` —
    /// instead of from the flags/env below. This is how the app runs us: on Windows any process
    /// under the same user can read another's environment block without elevation, and the
    /// passphrase decrypts the entire room. The flags stay for local runs.
    #[arg(long)]
    config_stdin: bool,

    /// Check whether this machine can hardware-encode, print `{"h264":bool,"h265":bool}` on one
    /// line and exit. The app runs it once per launch to decide whether to offer "Smooth Video",
    /// instead of letting every share try the helper and fall back.
    #[arg(long)]
    probe_encoders: bool,

    /// Print `{"hdr":bool}` — whether any monitor is in HDR — and exit. The app asks before a sharp
    /// share: on an HDR display it hands the share to `--engine sharp`, which tone-maps.
    #[arg(long)]
    probe_hdr: bool,

    /// macOS: capture the share's audio instead of video, and write it to stdout in
    /// audio-capture.exe's format (12-byte header, then interleaved float32). With --window-id it
    /// is that window's application, with --display-id or no target everything but mqvi.
    #[arg(long)]
    audio_capture: bool,

    /// macOS, with --audio-capture: the app's main process, whose applications (its Electron
    /// helpers included) are left out of the audio.
    #[arg(long)]
    self_pid: Option<i32>,

    /// LiveKit server URL (from the screen-token response `url`).
    #[arg(long, env = "LK_URL", required_unless_present_any = ["config_stdin", "probe_encoders", "probe_hdr", "audio_capture"])]
    url: Option<String>,

    /// LiveKit access token for the "{userId}_ss" identity (screen-token `token`).
    #[arg(long, env = "LK_TOKEN", required_unless_present_any = ["config_stdin", "probe_encoders", "probe_hdr", "audio_capture"])]
    token: Option<String>,

    /// Room E2EE passphrase (screen-token `e2eePassphrase`). Must equal what the
    /// app clients passed to ExternalE2EEKeyProvider.setKey for this room.
    #[arg(long, env = "LK_E2EE_KEY", required_unless_present_any = ["config_stdin", "probe_encoders", "probe_hdr", "audio_capture"])]
    e2ee_key: Option<String>,

    /// Frame width (kept even for I420 chroma subsampling).
    #[arg(long, default_value_t = 1280)]
    width: u32,

    /// Frame height (kept even for I420 chroma subsampling).
    #[arg(long, default_value_t = 720)]
    height: u32,

    /// Frames per second for the synthetic source.
    #[arg(long, default_value_t = 30)]
    fps: u32,

    /// Video codec. NVENC encodes h264/h265/av1 — NOT vp8/vp9.
    #[arg(long, value_enum, default_value_t = Codec::Vp8)]
    codec: Codec,

    /// Encoder backend: nvenc/hardware engage the GPU (require an h264/h265/av1 codec).
    #[arg(long, value_enum, default_value_t = Encoder::Auto)]
    encoder: Encoder,

    /// Frame source: an animated synthetic pattern, or real screen capture (WGC → hardware encode).
    /// `wgc` overrides width/height with the monitor's and forces `--encoder mf`.
    #[arg(long, value_enum, default_value_t = Source::Synthetic)]
    source: Source,

    /// Capture a single window whose title contains this text (case-insensitive) — e.g. a game —
    /// instead of the whole monitor. Avoids the mirror loop when viewing on the same screen. Implies
    /// WGC hardware capture. Dev convenience: the app passes --window-handle instead.
    #[arg(long)]
    window: Option<String>,

    /// Capture exactly this window (HWND). What the app's picker passes: a title can match the
    /// wrong window, a handle can't.
    #[arg(long)]
    window_handle: Option<isize>,

    /// Capture the monitor with these physical bounds, "x,y,width,height". What the app's picker
    /// passes for a screen share — the picked monitor, which need not be the primary one.
    #[arg(long)]
    monitor_rect: Option<String>,

    /// macOS: capture the display with this CGDirectDisplayID — the number in a desktopCapturer
    /// "screen:<id>:<n>" source id.
    #[arg(long)]
    display_id: Option<u32>,

    /// macOS: capture the window with this CGWindowID — the number in a desktopCapturer
    /// "window:<id>:<n>" source id.
    #[arg(long)]
    window_id: Option<u32>,

    /// Largest height the stream may use, from the app's screen-share quality setting. The source's
    /// own size wins when it's smaller — we never upscale. Omit to stream at the source's size.
    #[arg(long)]
    max_height: Option<u32>,

    /// Which share engine a WGC capture feeds: `smooth` (hardware H264/H265) or `sharp` (libwebrtc
    /// software VP9, the browser engine's codec — what the app uses on an HDR display, where the
    /// browser's own capture clips).
    #[arg(long, value_enum, default_value_t = Engine::Smooth)]
    engine: Engine,

    /// Bitrate ceiling for `--engine sharp`, from the app's own "Sharp Video" settings so both
    /// paths stream the same. Ignored by smooth, which sizes its own.
    #[arg(long)]
    max_bitrate: Option<u64>,
}

/// The dev-only harness switches, as the hardware pump reads them. Off in every app run.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct DevHarness {
    /// `MQVI_DEV_SAME_MS_EVERY`: hand every Nth encoded frame over in the same millisecond as the
    /// next, which libwebrtc drops — the repeatable drop the pass-through must recover from.
    same_ms_every: u64,
    /// `MQVI_DEV_IGNORE_KEYFRAME_REQUESTS`: answer no keyframe request, so the watchdog has to
    /// rebuild the encoder.
    ignore_keyframe_requests: bool,
    /// `MQVI_DEV_ONE_ENCODER_SESSION`: refuse an encoder built beside the running one, as a GPU
    /// with a single free session does — the rebuild has to free the old one first.
    one_encoder_session: bool,
}

#[cfg(any(windows, test))]
impl DevHarness {
    /// Read leniently and never as arguments: a value the parser rejected made every helper run
    /// exit at once — the launch-time encoder probe included, which quietly switched "Smooth
    /// Video" off. Anything unreadable means off.
    fn from_values(
        same_ms_every: Option<&str>,
        ignore_keyframe_requests: Option<&str>,
        one_encoder_session: Option<&str>,
    ) -> Self {
        let on = |v: Option<&str>| {
            matches!(
                v.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
                Some("1" | "true" | "yes" | "on")
            )
        };
        Self {
            same_ms_every: same_ms_every.and_then(|v| v.trim().parse().ok()).unwrap_or(0),
            ignore_keyframe_requests: on(ignore_keyframe_requests),
            one_encoder_session: on(one_encoder_session),
        }
    }

    #[cfg(windows)]
    fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self::from_values(
            var("MQVI_DEV_SAME_MS_EVERY").as_deref(),
            var("MQVI_DEV_IGNORE_KEYFRAME_REQUESTS").as_deref(),
            var("MQVI_DEV_ONE_ENCODER_SESSION").as_deref(),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, clap::ValueEnum)]
enum Engine {
    Smooth,
    Sharp,
}

/// Resolves when we are asked to stop, from wherever the request comes.
///
/// This has to be honoured from the moment we start capturing, not just once we're publishing: the
/// capture session (and its on-screen border) exists before the room connect, and that connect can
/// retry for a long time on a bad network. Anything that isn't heard here ends as a TerminateProcess
/// with the session still open.
async fn stop_requested() {
    tokio::select! {
        _ = tokio::signal::ctrl_c() => log::info!("ctrl-c"),
        _ = parent_asked_to_stop() => log::info!("stdin closed"),
    }
}

/// Resolves when the app closes our stdin — its way of asking us to shut down. Windows has no
/// signal to send a console-less child, so the alternative is TerminateProcess: the capture session
/// would never close (DWM keeps drawing the capture border over the shared screen) and we would
/// never leave the room (viewers keep a ghost share until the SFU times us out).
async fn parent_asked_to_stop() {
    use tokio::io::AsyncReadExt;
    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 32];
    loop {
        match stdin.read(&mut buf).await {
            Ok(0) | Err(_) => return, // EOF or a broken pipe: the app is done with us
            Ok(_) => {}               // ignore anything actually typed at a dev console
        }
    }
}

/// What we need to join the room. Either read as a JSON line on stdin (how the app runs us — see
/// Args::config_stdin) or taken from the flags/env.
struct Connection {
    url: String,
    token: String,
    e2ee_key: String,
}

impl Connection {
    fn resolve(args: &Args) -> Result<Self> {
        if !args.config_stdin {
            return Ok(Self {
                url: args.url.clone().context("--url is required")?,
                token: args.token.clone().context("--token is required")?,
                e2ee_key: args.e2ee_key.clone().context("--e2ee-key is required")?,
            });
        }

        // One line, read before the stop watcher starts consuming stdin for EOF.
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .context("reading the config line from stdin")?;
        let v: serde_json::Value =
            serde_json::from_str(line.trim()).context("parsing the config line from stdin")?;
        let field = |k: &str| -> Result<String> {
            v.get(k)
                .and_then(|s| s.as_str())
                .map(str::to_owned)
                .with_context(|| format!("config line has no '{k}'"))
        };
        Ok(Self {
            url: field("url")?,
            token: field("token")?,
            e2ee_key: field("e2eePassphrase")?,
        })
    }
}

/// Per codec: `true` if a real encoder comes up at the settings a share uses, `false` if the machine
/// lists none at all, `null` if one is listed but would not start. Only `false` is a fact about the
/// machine; a listed encoder that refuses may just be busy (NVENC's session limit while OBS or
/// ShadowPlay holds one), and the app must not switch "Smooth Video" off for the session over it.
#[cfg(windows)]
fn probe_encoders() -> String {
    if HwEncoder::startup().is_err() {
        return r#"{"h264":false,"h265":false}"#.to_string();
    }
    let probe = |hevc: bool| -> &'static str {
        if HwEncoder::new(1920, 1080, 30, 6_000_000, hevc).is_ok() {
            return "true";
        }
        match hardware_encoder_count(hevc) {
            Ok(0) => "false",
            _ => "null",
        }
    };
    format!(r#"{{"h264":{},"h265":{}}}"#, probe(false), probe(true))
}

/// macOS: libwebrtc's VideoToolbox backend is the encoder. It is listed only when this build has it;
/// whether a session really comes up is proven by the share's own first encoded frame, not here.
/// H.264 only: the smooth engine never asks the mac for H.265.
#[cfg(target_os = "macos")]
fn probe_encoders() -> String {
    let videotoolbox = VideoEncoderBackend::list_available()
        .into_iter()
        .any(|b| matches!(b, VideoEncoderBackend::VideoToolbox));
    format!(r#"{{"h264":{videotoolbox},"h265":false}}"#)
}

/// Whether the monitor at `rect` is in HDR — or, without one, whether any monitor is. A screen share
/// asks about its own monitor; a window asks about all of them, since it can be dragged to the HDR
/// one mid-share and only the helper follows that. `{"hdr":null}` when the displays cannot be asked:
/// the app then keeps the share in the browser, as before.
#[cfg(windows)]
fn probe_hdr(rect: Option<&str>) -> String {
    let answer = match rect {
        Some(r) => parse_rect(r).and_then(|(x, y, w, h)| display_light::hdr_at_rect(x, y, w, h)),
        None => display_light::any_hdr(),
    };
    match answer {
        Ok(hdr) => format!(r#"{{"hdr":{hdr}}}"#),
        Err(e) => {
            log::warn!("could not read the displays' HDR state: {e:#}");
            r#"{"hdr":null}"#.to_string()
        }
    }
}

/// macOS: the HDR route (a sharp share tone-mapped by this helper) is Windows-only, so the answer
/// that keeps a sharp share in the browser is the only one to give.
#[cfg(target_os = "macos")]
fn probe_hdr(_rect: Option<&str>) -> String {
    r#"{"hdr":false}"#.to_string()
}

/// "x,y,width,height" → (x, y, width, height).
#[cfg(windows)]
fn parse_rect(s: &str) -> Result<(i32, i32, i32, i32)> {
    let n: Vec<i32> = s
        .split(',')
        .map(|p| p.trim().parse::<i32>().context("monitor-rect wants integers"))
        .collect::<Result<_>>()?;
    match n[..] {
        [x, y, w, h] if w > 0 && h > 0 => Ok((x, y, w, h)),
        _ => bail!("monitor-rect must be \"x,y,width,height\" with a positive size, got '{s}'"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, clap::ValueEnum)]
enum Source {
    Synthetic,
    /// Windows: the primary monitor through Windows.Graphics.Capture.
    Wgc,
    /// macOS: the main display through ScreenCaptureKit.
    Sck,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum Codec {
    Vp8,
    Vp9,
    H264,
    H265,
    Av1,
}

impl Codec {
    fn to_lk(self) -> VideoCodec {
        match self {
            Codec::Vp8 => VideoCodec::VP8,
            Codec::Vp9 => VideoCodec::VP9,
            Codec::H264 => VideoCodec::H264,
            Codec::H265 => VideoCodec::H265,
            Codec::Av1 => VideoCodec::AV1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, clap::ValueEnum)]
enum Encoder {
    Auto,
    Software,
    Hardware,
    Nvenc,
    /// Our own Media Foundation hardware encoder, fed through livekit's PreEncoded path.
    /// This is the working hardware path (libwebrtc's prebuilt has no built-in NVENC).
    Mf,
}

impl Encoder {
    fn to_lk(self) -> VideoEncoderBackend {
        match self {
            Encoder::Auto => VideoEncoderBackend::Auto,
            Encoder::Software => VideoEncoderBackend::Software,
            Encoder::Hardware => VideoEncoderBackend::Hardware,
            Encoder::Nvenc => VideoEncoderBackend::Nvenc,
            Encoder::Mf => VideoEncoderBackend::PreEncoded,
        }
    }
}

/// macOS: the share's audio on stdout, until the app closes our stdin. Blocking all the way
/// through (ScreenCaptureKit, stdout, stdin), so off the async workers.
#[cfg(target_os = "macos")]
async fn run_audio_capture(args: &Args) -> Result<()> {
    use mqvi_game_capture::mac_audio::{self, AudioTarget};
    let target = match (args.window_id, args.display_id) {
        (Some(id), _) => AudioTarget::Window(id),
        (None, Some(id)) => AudioTarget::Display(id),
        (None, None) => AudioTarget::AllButOurs,
    };
    let self_pid = args.self_pid;
    tokio::task::spawn_blocking(move || mac_audio::run(target, self_pid))
        .await
        .context("audio capture thread")?
}

/// Windows has its own audio helper, audio-capture.exe.
#[cfg(windows)]
async fn run_audio_capture(_args: &Args) -> Result<()> {
    bail!("--audio-capture is macOS-only; Windows uses audio-capture.exe")
}

/// Windows: WGC, encoded by our MF encoder. The app addresses its picked source exactly
/// (--window-handle / --monitor-rect); the title and primary-monitor forms are dev conveniences.
#[cfg(windows)]
fn open_capture(args: &Args) -> Result<Option<ScreenCapture>> {
    if args.source == Source::Sck || args.display_id.is_some() || args.window_id.is_some() {
        bail!("--source sck, --display-id and --window-id are macOS-only");
    }
    let cap = if let Some(handle) = args.window_handle {
        let cap = ScreenCapture::window_by_handle(handle)?;
        log::info!("WGC window capture hwnd={handle}: {}x{}", cap.width() & !1, cap.height() & !1);
        cap
    } else if let Some(rect) = &args.monitor_rect {
        let (x, y, w, h) = parse_rect(rect)?;
        let cap = ScreenCapture::monitor_by_rect(x, y, w, h)?;
        log::info!("WGC monitor capture at {x},{y}: {}x{}", cap.width() & !1, cap.height() & !1);
        cap
    } else if let Some(title) = &args.window {
        let cap = ScreenCapture::window_by_title(title)?;
        log::info!("WGC window capture '{title}': {}x{}", cap.width() & !1, cap.height() & !1);
        cap
    } else if args.source == Source::Wgc {
        let cap = ScreenCapture::primary_monitor()?;
        log::info!("WGC monitor capture: {}x{}", cap.width() & !1, cap.height() & !1);
        cap
    } else {
        return Ok(None);
    };
    Ok(Some(cap))
}

/// macOS: ScreenCaptureKit, encoded by libwebrtc's VideoToolbox backend. Found and measured here,
/// started once the track is published.
#[cfg(target_os = "macos")]
fn open_capture(args: &Args) -> Result<Option<mac_capture::Source>> {
    if args.window_handle.is_some()
        || args.monitor_rect.is_some()
        || args.window.is_some()
        || args.source == Source::Wgc
    {
        bail!("--window-handle, --monitor-rect, --window and --source wgc are Windows-only");
    }
    let target = match (args.window_id, args.display_id, args.source) {
        (Some(_), Some(_), _) => bail!("--window-id and --display-id are exclusive"),
        (Some(id), None, _) => mac_capture::Target::Window(id),
        (None, Some(id), _) => mac_capture::Target::Display(id),
        (None, None, Source::Sck) => mac_capture::Target::MainDisplay,
        _ => return Ok(None),
    };
    let src = mac_capture::Source::find(target)?;
    log::info!("ScreenCaptureKit {}: {}x{}", src.label(), src.width() & !1, src.height() & !1);
    Ok(Some(src))
}

fn main() -> Result<()> {
    // Windows gives the main thread only a 1 MB stack; libwebrtc's PeerConnection setup has deep
    // call chains (worse in debug builds) that overflow it — the crash lands on 'main'. Run the
    // runtime on a large-stack thread and give tokio's worker threads a big stack too.
    let handle = std::thread::Builder::new()
        .name("mqvi-gc".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(16 * 1024 * 1024)
                .build()
                .context("failed to build tokio runtime")?;
            let result = rt.block_on(run());

            // Not a plain drop: that waits for every blocking task, and libwebrtc keeps a pool of
            // them parked for the process's lifetime — so the drop never returns, this thread never
            // finishes, the join below waits forever and the process outlives the share it was
            // drawing. Measured after a game was closed: `run` had returned and logged its way out,
            // yet all 18 threads sat parked at 0% CPU for as long as anyone watched.
            //
            // Nothing is lost by leaving now. `run` closes the room and joins the encode thread
            // before it returns, so what is abandoned here is only the pool nobody is waiting on.
            rt.shutdown_background();
            result
        })
        .context("failed to spawn worker thread")?;
    let result = handle.join().map_err(|_| anyhow::anyhow!("worker thread panicked"))?;
    if let Err(e) = &result {
        if is_source_gone(e) {
            log::info!("{e}");
            std::process::exit(SOURCE_GONE_EXIT);
        }
    }
    result
}

async fn run() -> Result<()> {
    // RUST_LOG=livekit=debug surfaces the SDK's connection/E2EE internals.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args = Args::parse();
    if args.probe_encoders {
        println!("{}", probe_encoders());
        return Ok(());
    }
    if args.probe_hdr {
        println!("{}", probe_hdr(args.monitor_rect.as_deref()));
        return Ok(());
    }
    if args.audio_capture {
        return run_audio_capture(&args).await;
    }
    // Read before anything slow: the app writes this line right after spawning us.
    let conn = Connection::resolve(&args)?;
    let mut width = args.width & !1; // force even
    let mut height = args.height & !1;
    let fps = args.fps.max(1);

    // Real capture: dimensions come from the source (window or monitor).
    let capture = open_capture(&args)?;
    if let Some(cap) = &capture {
        width = cap.width() & !1;
        height = cap.height() & !1;
    }
    let has_capture = capture.is_some();

    // Sizing is settled here, with the capture and before anything network: the stream's size is a
    // function of the source and the app's quality cap, and nothing later gets to disagree.
    // The cap bounds the stream, not the capture — we grab the source at its own size and scale
    // down, so a 1440p monitor honours a 720p setting instead of ignoring it.
    let max = match args.max_height {
        Some(h) => ((h as u64 * 16 / 9) as u32, h),
        None => (u32::MAX, u32::MAX),
    };
    if capture.is_some() {
        let canvas = canvas_for(width, height, max);
        if canvas != (width, height) {
            log::info!(
                "source {width}x{height} → streaming {}x{} (cap {}p)",
                canvas.0, canvas.1, max.1
            );
            (width, height) = canvas;
        }
    }

    // E2EE: shared-key provider seeded with the room passphrase. Defaults give
    // salt="LKFrameEncryptionKey" + PBKDF2, matching the JS ExternalE2EEKeyProvider.
    let key_provider =
        KeyProvider::with_shared_key(KeyProviderOptions::default(), conn.e2ee_key.into_bytes());

    let mut room_options = RoomOptions::default();
    room_options.encryption = Some(E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider });
    // We only publish; no need to subscribe to anyone in this spike.
    room_options.auto_subscribe = false;

    // One stop future for the whole process. Building it inside a select! arm instead would park a
    // fresh blocking stdin read on every loop iteration — tokio can't cancel those, so each room
    // event would strand a thread (measured: ~1 per event, up to the 512 blocking-pool cap, each
    // reserving this runtime's 16 MB stack).
    let stop_signal = stop_requested();
    tokio::pin!(stop_signal);

    log::info!("connecting to {}", conn.url);
    // Racing the connect matters: it retries for a long time on a bad network, and we're already
    // capturing — bailing out here drops `capture`, which closes the session and its border.
    let (room, mut events) = tokio::select! {
        connected = Room::connect(&conn.url, &conn.token, room_options) => {
            connected.context("LiveKit connect failed (check url/token/network)")?
        }
        _ = &mut stop_signal => {
            log::info!("asked to stop while connecting — shutting down");
            return Ok(());
        }
    };
    let local = room.local_participant();
    log::info!(
        "connected as identity={} room={}",
        local.identity().as_str(),
        room.name()
    );

    let sharp = args.engine == Engine::Sharp;
    if sharp && capture.is_none() {
        bail!("--engine sharp needs a capture source");
    }
    // The mac has neither our MF encoder nor the HDR sharp route: its capture feeds libwebrtc raw
    // frames, which VideoToolbox encodes.
    if cfg!(target_os = "macos") && (sharp || args.encoder == Encoder::Mf) {
        bail!("--engine sharp and --encoder mf are Windows-only");
    }
    let use_mf = cfg!(windows) && !sharp && (args.encoder == Encoder::Mf || capture.is_some());
    let mac_capture = cfg!(target_os = "macos") && has_capture;
    // WGC smooth always hardware-encodes; default its codec (otherwise vp8) to h264. Sharp is VP9,
    // the browser engine's codec, whatever was asked.
    let codec = if sharp {
        Codec::Vp9
    } else if capture.is_some() && !matches!(args.codec, Codec::H264 | Codec::H265) {
        Codec::H264
    } else {
        args.codec
    };
    #[cfg(windows)]
    let hevc = matches!(codec, Codec::H265);
    if use_mf && !matches!(codec, Codec::H264 | Codec::H265) {
        bail!("hardware encode (--encoder mf) needs --codec h264 or h265");
    }

    // MF path hands livekit pre-encoded access units (new_encoded); otherwise a raw I420
    // source that libwebrtc encodes itself (is_screencast=true = screen content hint).
    let res = VideoResolution { width, height };
    // Sharp says "not screencast" on purpose: it is what livekit-client does for VP9 screen shares
    // (contentHint "motion"), because libwebrtc's screencast path holds VP9 L1T3 to a few fps.
    let rtc_source = if use_mf {
        NativeVideoSource::new_encoded(res)
    } else {
        NativeVideoSource::new(res, !sharp)
    };
    let track_name = if sharp { TRACK_NAME_SHARP } else { TRACK_NAME_SMOOTH };
    let track = LocalVideoTrack::create_video_track(track_name, RtcVideoSource::Native(rtc_source.clone()));
    let watched_track = track.clone();

    let backends: Vec<_> = VideoEncoderBackend::list_available().into_iter().collect();
    log::info!("available encoder backends: {backends:?}");

    let mut publish_opts = TrackPublishOptions::default();
    publish_opts.source = TrackSource::Screenshare;
    publish_opts.video_codec = codec.to_lk();
    // Our encoder hands livekit one finished stream — it cannot produce simulcast layers. Left on
    // (the SDK's default), the SDK declares a half-size 3fps layer beside it and the rate allocator
    // budgets our single stream as that layer: a flat 150 kbps, whatever the link can really do.
    // A 1080p game at 150 kbps is the mush this looked like from NGC-01 onwards.
    // The mac's VideoToolbox could encode real layers, but stays single-layer like Windows: one
    // encoder session, and viewers get the same stream from either platform.
    publish_opts.simulcast = false;
    // And say what the stream is worth, rather than letting the SDK guess from a track that hasn't
    // encoded a frame yet. WebRTC still pulls it down to what the link takes; this is the ceiling.
    publish_opts.video_encoding = Some(VideoEncoding {
        max_bitrate: match (sharp, args.max_bitrate) {
            (true, Some(b)) => b,
            _ => target_bitrate(width, height, fps),
        },
        max_framerate: fps as f64,
    });
    // We hand livekit already-encoded frames on the MF path → PreEncoded pass-through (no re-encode).
    publish_opts.video_encoder = if use_mf {
        VideoEncoderBackend::PreEncoded
    } else if sharp {
        VideoEncoderBackend::Software
    } else if mac_capture {
        VideoEncoderBackend::VideoToolbox
    } else {
        args.encoder.to_lk()
    };
    // The browser engine's exact shape: one spatial layer, three temporal, so the SFU can still thin
    // the frame rate for a weak viewer. More spatial layers is what livekit-client avoids for VP9
    // screen shares — it drops the publish resolution to the smallest layer.
    if sharp {
        publish_opts.scalability_mode = Some("L1T3".to_string());
    }

    local
        .publish_track(LocalTrack::Video(track), publish_opts)
        .await
        .context("publish_track failed")?;
    log::info!(
        "published track '{track_name}' ({width}x{height}@{fps}, codec={:?}, encoder={}, capture={}, E2EE/GCM)",
        codec,
        if use_mf {
            "hardware MFT (pre-encoded)"
        } else if mac_capture {
            "VideoToolbox"
        } else if sharp {
            "libwebrtc software"
        } else {
            "libwebrtc"
        },
        if has_capture { "screen" } else { "synthetic" },
    );

    // Capture and MF encoding make blocking calls → dedicated OS thread (smooth and sharp alike).
    // The synthetic raw path → tokio task.
    let stop = Arc::new(AtomicBool::new(false));
    // `ready` fires on the first frame the encoder actually delivers; `died` on a fatal encode
    // failure. The hardware encoder is created inside the pump and can fail outright (no MFT on
    // this machine) or die later (a GPU driver reset — routine for our workload, a fullscreen
    // game), and neither shows up as a process exit.
    let (ready_tx, ready_rx) = oneshot::channel::<String>();
    // The cause as text, and whether it was the source going away rather than a fault. Several
    // senders on the mac (the capture, and the check that its encoder is really hardware); one on
    // Windows. The first reason sent is the one reported.
    let (died_tx, mut died_rx) = mpsc::unbounded_channel::<(String, bool)>();
    #[cfg(windows)]
    let mf_thread = start_windows_pump(
        use_mf || sharp,
        sharp,
        VideoConfig { width, height, fps, hevc, max },
        capture,
        rtc_source.clone(),
        stop.clone(),
        ready_tx,
        died_tx,
    );
    // ScreenCaptureKit runs on its own queue; there is no thread of ours to start or join. Ready
    // waits for proof that VideoToolbox, in hardware, encoded the first frame.
    #[cfg(target_os = "macos")]
    let (mac_stream, encode_check) = match capture {
        Some(src) => {
            let (frame_tx, frame_rx) = oneshot::channel::<()>();
            let check = tokio::spawn(confirm_hardware_encode(watched_track.clone(), frame_rx, ready_tx, died_tx.clone()));
            let stream = start_mac_capture(&src, (width, height), fps, max, rtc_source.clone(), frame_tx, died_tx)?;
            (Some(stream), Some(check))
        }
        None => (None, None),
    };
    let raw_pump = (!use_mf && !sharp && !has_capture)
        .then(|| tokio::spawn(frame_pump(rtc_source, width, height, fps)));

    // "Published" is not "streaming": the track exists, but nothing is on it until the encoder
    // delivers. Announcing readiness before that is how a machine with no hardware encoder ends up
    // with the app committed to a stream that stays black forever.
    let mut startup_error = None;
    let mut no_frames = false;
    let waits_for_first_frame = use_mf || sharp || mac_capture;
    let mut streaming = !waits_for_first_frame;
    if waits_for_first_frame {
        tokio::select! {
            first = ready_rx => match first {
                Ok(encoder) => {
                    log::info!("encoding with {encoder}");
                    streaming = true;
                }
                // Sender dropped: the pump bailed before delivering anything. Which of its dozen
                // failures it was is on `died_rx`, but not reliably readable until the thread has
                // finished — so the message is built after the join below, not here. Reporting
                // "no frames" on its own names the symptom and drops the fault: v2.23.1 shipped
                // that and the first production report was unactionable.
                Err(_) => no_frames = true,
            },
            _ = &mut stop_signal => log::info!("asked to stop before the first frame"),
        }
    }

    // Smooth only: its frames are already encoded, so a frame libwebrtc drops costs viewers a freeze
    // until the next keyframe, and nothing but these counters shows it.
    let delivery = (streaming && use_mf).then(|| tokio::spawn(delivery_watch::watch(watched_track.clone())));
    // The mac asks libwebrtc for VideoToolbox; only the sender's stats show whether it got it.
    #[cfg(target_os = "macos")]
    let encoder = (streaming && mac_capture).then(|| tokio::spawn(encoder_watch::watch(watched_track.clone())));

    if streaming {
        // The app waits for exactly this line before it commits to the native engine.
        println!("MQVI-READY");

        loop {
            tokio::select! {
                _ = &mut stop_signal => {
                    log::info!("shutting down");
                    break;
                }
                reason = died_rx.recv() => {
                    // The same trap as the startup path: `reason` IS the cause, so putting a
                    // generic sentence in the error throws away the only line that names the fault.
                    // Exiting is the only way the app learns: it watches for our process to end.
                    let (cause, gone) = reason.unwrap_or_else(|| ("no reason given".into(), false));
                    startup_error = Some(if gone {
                        anyhow::Error::new(SourceGone)
                    } else {
                        anyhow!("{cause} (encoder stopped mid-stream)")
                    });
                    break;
                }
                event = events.recv() => {
                    match event {
                        Some(RoomEvent::Disconnected { reason }) => {
                            log::warn!("room disconnected: {reason:?}");
                            break;
                        }
                        Some(ev) => log::debug!("room event: {ev:?}"),
                        None => break, // room handle dropped / channel closed
                    }
                }
            }
        }
    }

    // Staged so a hang here is diagnosable from the log alone: this process ending is the only way
    // the app learns the share is over, so "stuck on the way out" and "still streaming" look
    // identical from the outside.
    log::info!("shutdown: signalling pump");
    stop.store(true, Ordering::Relaxed);
    if let Some(p) = raw_pump {
        p.abort();
    }
    if let Some(w) = delivery {
        w.abort();
    }
    #[cfg(target_os = "macos")]
    for task in [encoder, encode_check].into_iter().flatten() {
        task.abort();
    }
    // Joining matters: the pump owns `capture`, so this is where the WGC session gets closed.
    #[cfg(windows)]
    {
        log::info!("shutdown: joining encode thread");
        if let Some(t) = mf_thread {
            let _ = t.join();
        }
    }
    // Dropping the stream stops ScreenCaptureKit; no frame reaches the track after this.
    #[cfg(target_os = "macos")]
    {
        log::info!("shutdown: stopping capture");
        drop(mac_stream);
    }
    // Every failure inside the pump funnels through `died_tx` — encoder creation, a rejected input
    // type, frames refused, frames accepted but never returned. The join above is what makes this
    // readable: the thread has run its error handler by now, so the cause is already in the channel.
    if no_frames {
        // Read here and nowhere else. A working share must not pay for it, and more to the point
        // must not be put at risk by it: this is fresh Media Foundation code, and running it on the
        // path that already failed means the worst it can cost is a report, never a share.
        //
        // The distinction it buys is the one an encode error cannot make alone — "this GPU exposes
        // no H264 encoder at all" and "the encoder is right there and refused our settings" reach
        // the operator as the same failed share otherwise.
        // Only the hardware path has encoders to describe; sharp's encoder is libwebrtc's own.
        #[cfg(windows)]
        let encoders = if sharp { sharp_pump::ENCODER_NAME.to_string() } else { describe_hardware_encoders() };
        #[cfg(target_os = "macos")]
        let encoders = "VideoToolbox (libwebrtc)".to_string();
        startup_error = Some(match died_rx.try_recv() {
            Ok((cause, _)) => anyhow!("{cause} (no frames produced; {encoders})"),
            // The pump only returns Ok once `stop` is set, and that happens above — so reaching
            // this means it ended without going through its own error handler.
            Err(_) => anyhow!("no frames produced and no reason reported; {encoders}"),
        });
    }

    log::info!("shutdown: closing room");
    room.close().await.ok();
    log::info!("shutdown: done");
    match startup_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Windows: capture and MF encoding make blocking calls, so they run on a dedicated OS thread
/// (smooth and sharp alike). None when there is nothing to pump (the synthetic raw path).
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn start_windows_pump(
    pumped: bool,
    sharp: bool,
    cfg: VideoConfig,
    capture: Option<ScreenCapture>,
    src: NativeVideoSource,
    stop: Arc<AtomicBool>,
    ready_tx: oneshot::Sender<String>,
    died_tx: mpsc::UnboundedSender<(String, bool)>,
) -> Option<std::thread::JoinHandle<()>> {
    if !pumped {
        return None;
    }
    let dev = DevHarness::from_env();
    if dev.same_ms_every > 0 || dev.ignore_keyframe_requests || dev.one_encoder_session {
        log::warn!(
            "dev harness on: same-ms pair every {} frames, ignore keyframe requests {}, one encoder session {}",
            dev.same_ms_every,
            dev.ignore_keyframe_requests,
            dev.one_encoder_session
        );
    }
    Some(std::thread::spawn(move || {
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
    }))
}

/// macOS: starts ScreenCaptureKit into `video`. `first_frame` fires on the first frame handed
/// over, and a share that ends by itself reports on the same died channel the Windows pump uses.
#[cfg(target_os = "macos")]
fn start_mac_capture(
    src: &mac_capture::Source,
    canvas: (u32, u32),
    fps: u32,
    max: (u32, u32),
    video: NativeVideoSource,
    first_frame: oneshot::Sender<()>,
    died_tx: mpsc::UnboundedSender<(String, bool)>,
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

/// How long after the first captured frame VideoToolbox has to show an encoded one.
#[cfg(target_os = "macos")]
const ENCODE_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);

/// macOS: announces ready only once the sender's stats show a frame encoded in hardware. Asking
/// libwebrtc for VideoToolbox is not getting it: it can fall back to a software H.264 encoder without
/// saying so, and a software "Smooth Video" is the CPU-bound share this engine exists to avoid. The
/// app then falls back to "Sharp Video", whose software VP9 does that job better.
#[cfg(target_os = "macos")]
async fn confirm_hardware_encode(
    track: LocalVideoTrack,
    first_frame: oneshot::Receiver<()>,
    ready: oneshot::Sender<String>,
    died: mpsc::UnboundedSender<(String, bool)>,
) {
    // The capture ended before a frame: it has reported why, and dropping `ready` says none came.
    if first_frame.await.is_err() {
        return;
    }
    let deadline = std::time::Instant::now() + ENCODE_CONFIRM_TIMEOUT;
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Absent briefly while the sender comes up; the deadline below bounds the wait.
        let reading = track.get_stats().await.ok().and_then(|s| encoder_watch::EncoderReading::from_stats(&s));
        if let Some(r) = reading.filter(|r| r.frames_encoded > 0) {
            let name = if r.implementation.is_empty() { "an unnamed encoder".to_string() } else { r.implementation };
            if r.hardware {
                let _ = ready.send(name);
            } else {
                let _ = died.send((format!("libwebrtc encoded with {name}, which is not a hardware encoder"), false));
            }
            return;
        }
        if std::time::Instant::now() >= deadline {
            let _ = died.send((format!("no frame encoded within {}s of the first capture", ENCODE_CONFIRM_TIMEOUT.as_secs()), false));
            return;
        }
    }
}

/// What the pump encodes: frame geometry and codec, settled before it starts.
#[cfg(windows)]
#[derive(Clone, Copy)]
struct VideoConfig {
    width: u32,
    height: u32,
    fps: u32,
    hevc: bool,
    /// Ceiling from the app's quality setting. The canvas never exceeds it, and never upscales
    /// past the source either — a 800x600 window at a 1080p cap streams 800x600, not a blur.
    max: (u32, u32),
}

/// The stream size for a source of `src_w`x`src_h`: its own size, shrunk to fit the cap if it
/// doesn't already, aspect kept, even (NV12 chroma pairs).
fn canvas_for(src_w: u32, src_h: u32, max: (u32, u32)) -> (u32, u32) {
    let (src_w, src_h) = (src_w.max(2), src_h.max(2));
    if src_w <= max.0 && src_h <= max.1 {
        return (src_w & !1, src_h & !1);
    }
    let by_width = max.1 as u64 * src_w as u64 >= max.0 as u64 * src_h as u64;
    let (w, h) = if by_width {
        (max.0, (max.0 as u64 * src_h as u64 / src_w as u64) as u32)
    } else {
        ((max.1 as u64 * src_w as u64 / src_h as u64) as u32, max.1)
    };
    (w.max(2) & !1, h.max(2) & !1)
}

/// How long the source must hold a size before the stream follows it. Without this, dragging a
/// window's edge would rebuild the encoder on every mouse move.
#[cfg(windows)]
const RESIZE_SETTLE: Duration = Duration::from_millis(500);

/// The ceiling we reserve for the stream: roughly 0.1 bits per pixel per frame — 1080p30 ≈ 6 Mbps,
/// 720p30 ≈ 2.8 — which is the range Discord and Twitch use for a 1080p game. WebRTC still pulls
/// the real rate down to whatever the link takes; this only stops it being decided for us.
fn target_bitrate(width: u32, height: u32, fps: u32) -> u64 {
    let by_pixels = width as u64 * height as u64 * fps as u64 / 10;
    by_pixels.clamp(1_500_000, 12_000_000)
}

/// Registers the calling thread with the Multimedia Class Scheduler for as long as it lives.
///
/// Measured, not guessed: on a machine where Battlefield 6 held the CPU at 95%+, the pump fed
/// 8–23 fps instead of 30 while `sent` tracked `fed` exactly — the encoder was keeping up with
/// everything it was given, and the shortfall was upstream of it. Diablo and Forza, which leave
/// CPU headroom, held 30. The pump was a plain `std::thread::spawn` at normal priority competing
/// with a game across every core.
///
/// MMCSS is what Windows provides for exactly this: a media thread gets guaranteed slices, and the
/// scheduler still caps all MMCSS threads together (SystemResponsiveness) so this cannot starve
/// the machine. Ours sleeps to an absolute schedule between frames, so it is a well-behaved
/// tenant — high priority, low duty cycle.
///
/// Best effort by design. MMCSS can be disabled or the service absent; a share that runs at normal
/// priority is worse, not broken, and must not fail to start over this.
#[cfg(windows)]
struct MmcssHandle(HANDLE);

#[cfg(windows)]
impl MmcssHandle {
    fn register(task: &str) -> Option<Self> {
        let wide: Vec<u16> = task.encode_utf16().chain(std::iter::once(0)).collect();
        let mut index = 0u32;
        unsafe {
            match AvSetMmThreadCharacteristicsW(PCWSTR(wide.as_ptr()), &mut index) {
                Ok(h) if !h.is_invalid() => {
                    if let Err(e) = AvSetMmThreadPriority(h, AVRT_PRIORITY_HIGH) {
                        // Registered but not promoted: still better than nothing, so keep it.
                        log::warn!("MMCSS priority not raised: {e}");
                    }
                    log::info!("MMCSS: pump registered as '{task}'");
                    Some(Self(h))
                }
                Ok(_) => None,
                Err(e) => {
                    log::warn!("MMCSS unavailable, pump runs at normal priority: {e}");
                    None
                }
            }
        }
    }
}

#[cfg(windows)]
impl Drop for MmcssHandle {
    fn drop(&mut self) {
        // Every exit path — clean stop, encoder error, `?` on a rebuild — gives the registration
        // back. Leaking it would leave a dead thread's slot held in the scheduler's task group.
        unsafe {
            let _ = AvRevertMmThreadCharacteristics(self.0);
        }
    }
}

/// What every encoder in one pump shares; a rebuild changes only the size and the bitrate.
#[cfg(windows)]
#[derive(Clone, Copy)]
struct EncoderSpec {
    fps: u32,
    hevc: bool,
    dev: DevHarness,
}

#[cfg(windows)]
impl EncoderSpec {
    /// The encoder that replaces `enc` at `size` and `bps` — see encoder_swap — with the VBV rule
    /// restarted from it. Every rebuild comes through here, so none can forget that restart.
    fn rebuild(
        self,
        enc: HwEncoder,
        size: (u32, u32),
        bps: u32,
        vbv_follow: &mut vbv_follow::VbvFollow,
        why: &'static str,
    ) -> Result<HwEncoder> {
        let next = encoder_swap::replace(enc, |beside| {
            // The dev harness refuses a second encoder the way a GPU with one free session does.
            if beside && self.dev.one_encoder_session {
                bail!("dev harness: no second encoder session");
            }
            HwEncoder::new(size.0, size.1, self.fps, bps, self.hevc)
        })
        .context(why)?;
        vbv_follow.rebuilt(bps, std::time::Instant::now());
        Ok(next)
    }
}

/// MF hardware-encode pump (dedicated OS thread): NV12 (synthetic or WGC-captured screen) →
/// hardware H264/H265 → livekit PreEncoded. Blocking encode() lives off the tokio runtime.
#[cfg(windows)]
fn encoded_pump(
    source: NativeVideoSource,
    cfg: VideoConfig,
    mut capture: Option<ScreenCapture>,
    stop: Arc<AtomicBool>,
    ready: oneshot::Sender<String>,
    dev: DevHarness,
) -> Result<()> {
    let VideoConfig { mut width, mut height, fps, hevc, max } = cfg;

    // Held for the life of the pump; dropping it reverts the registration. "Capture" is the task
    // profile Windows ships for this kind of thread.
    #[cfg(windows)]
    let _mmcss = MmcssHandle::register("Capture");

    // Start at a third of what we reserved, and let WebRTC's feedback ramp it to what the link
    // really allows — starting at the ceiling floods the pipe before the first estimate arrives,
    // and the opening seconds queue up behind it as delay.
    let bitrate = (target_bitrate(width, height, fps) / 3) as u32;
    HwEncoder::startup()?;
    let mut enc = HwEncoder::new(width, height, fps, bitrate, hevc)?;
    log::info!("hardware encoder: {}", enc.name());
    let spec = EncoderSpec { fps, hevc, dev };

    let codec = if hevc { EncodedVideoCodec::H265 } else { EncodedVideoCodec::H264 };
    let frame_us = 1_000_000i64 / fps as i64;
    // The size the source wants next, and since when — the stream only follows once it settles.
    let mut wanted: Option<((u32, u32), std::time::Instant)> = None;
    let mut rebuild_idr = false;
    let mut idx: u64 = 0;
    let t0 = std::time::Instant::now();
    // For WGC: the latest NV12 frame, reused when no new WGC frame arrived (static screen) so the
    // stream holds `fps`. `have_frame` guards the first ticks before any frame is captured.
    let mut cur = Vec::new();
    let mut have_frame = false;

    // What the pump did this second, reported once a second: tells us whether it keeps ~fps or
    // stalls, and what the encoder made of it — see pump_stats.
    let mut stats = pump_stats::PumpStats::default();
    let mut last_report = std::time::Instant::now();
    // How the encoder's bitrate follows libwebrtc's target — see rate_policy.
    let mut rate = rate_policy::RatePolicy::new(bitrate);
    // When a new encoder is due so its VBV fits that bitrate — see vbv_follow.
    let mut vbv_follow = vbv_follow::VbvFollow::new(bitrate, std::time::Instant::now());
    // libwebrtc's latest target, as it gave it.
    let mut last_estimate = 0u32;
    // Whether the encoder refused the last bitrate: one without bitrate control refuses every value,
    // and saying so five times a second says nothing new.
    let mut refusing = false;
    // When the last frame went to livekit — see pump_timing.
    let mut last_handoff: Option<std::time::Instant> = None;
    // An encoder that ignores keyframe requests is rebuilt — see keyframe_watch.
    let mut keyframe_watch = keyframe_watch::KeyframeWatch::default();
    // Dev harness only: a frame held back to go out with the next, and the handoffs so far.
    let mut held: Option<EncodedPacket> = None;
    let mut handoffs = 0u64;
    // Announced once, on the first frame the encoder really delivers.
    let mut ready = Some(ready);
    // A transient encode error must not kill the stream, but a dead MFT (driver reset) fails every
    // frame forever — without a limit the app sees a live helper and viewers a frozen picture.
    let mut consecutive_errors = 0u32;
    // The other half of that: an encoder can stop delivering without ever returning an error.
    let mut silent_reports = 0u32;

    while !stop.load(Ordering::Relaxed) {
        // A pump a full frame behind (the game took the CPU) resumes at the current slot.
        let (slot, skipped) =
            pump_timing::skip_missed_slots(idx, t0.elapsed().as_micros() as u64, frame_us as u64);
        idx = slot;
        stats.skipped_slots += skipped;
        // Absolute schedule: frame idx is due at t0 + idx*frame_us. Sleeping to an absolute target
        // (not interval-minus-work) keeps delivery even — relative sleeps accumulate drift/jitter
        // when encode() takes a variable time, which shows as the stream stretching then snapping.
        let due = t0 + Duration::from_micros(idx * frame_us as u64);
        if let Some(d) = due.checked_duration_since(std::time::Instant::now()) {
            std::thread::sleep(d);
        }

        // The SFU raises a keyframe request (PLI/FIR) when a subscriber needs an IDR — e.g. after
        // packet loss, so the decoder recovers instead of ghosting. Force one this frame.
        // A rebuilt encoder needs one too, or subscribers can't decode the new size at all.
        let requested = source.take_keyframe_request();
        if requested {
            keyframe_watch.requested();
        }
        let force_key = (requested && !dev.ignore_keyframe_requests) || rebuild_idr;
        if force_key {
            stats.keyframes_asked += 1;
        }
        rebuild_idr = false;
        // Follow libwebrtc's target: whatever the encoder makes above it, libwebrtc may drop after
        // it is already a reference.
        if let Some(rc) = source.take_rate_control_request() {
            last_estimate = rc.target_bitrate_bps as u32;
        }
        let kept = rate.applied();
        if let Some(bps) = rate.next(last_estimate, std::time::Instant::now()) {
            let taken = enc.set_bitrate(bps);
            if !taken {
                rate.refused(kept);
                if !refusing {
                    log::warn!("{} refused {} kbps, keeping {} kbps", enc.name(), bps / 1000, kept / 1000);
                }
            }
            refusing = !taken;
        }
        if vbv_follow.should_rebuild(rate.applied(), std::time::Instant::now()) {
            log::info!(
                "new encoder for the VBV: sized for {} kbps, running at {} kbps",
                vbv_follow.basis() / 1000,
                rate.applied() / 1000
            );
            let why = "rebuilding the encoder for a new VBV";
            enc = spec.rebuild(enc, (width, height), rate.applied(), &mut vbv_follow, why)?;
            // A fresh MFT opens with an IDR; asking keeps it to that one.
            rebuild_idr = true;
            continue;
        }

        // Frame source: real screen (reuse last on no-change) or the synthetic pattern. Both
        // convert into `cur`, which is kept across frames — see nv12::bgra_to_nv12_into.
        match &mut capture {
            Some(cap) => {
                // An error here is the source itself going away (window closed, display removed) —
                // ending the process is what tells the app to stop the share and say so. Silence is
                // not an error: WGC only delivers on change.
                if let Some(f) = cap.next_frame()? {
                    // Geometry comes from the frame, never from what the source was at startup —
                    // it resizes under us. Scaling into the canvas keeps the stream alive and
                    // correct through the change; the canvas itself follows below, once settled.
                    let (fw, fh, fstride) = (f.width, f.height, f.stride);
                    nv12::bgra_to_nv12_fit_into(
                        f.data,
                        fw as usize,
                        fh as usize,
                        fstride,
                        width as usize,
                        height as usize,
                        &mut cur,
                    );
                    have_frame = true;

                    // Follow the source, but only once it holds still: dragging an edge fires a
                    // resize per mouse move, and each rebuild costs an encoder and a keyframe.
                    let want = canvas_for(fw, fh, max);
                    if want == (width, height) {
                        wanted = None;
                    } else {
                        let settled = match wanted {
                            Some((w, since)) if w == want => since.elapsed() >= RESIZE_SETTLE,
                            _ => {
                                wanted = Some((want, std::time::Instant::now()));
                                false
                            }
                        };
                        if settled {
                            log::info!("stream {width}x{height} → {}x{} (source settled)", want.0, want.1);
                            let why = "rebuilding the encoder for the new size";
                            enc = spec.rebuild(enc, want, rate.applied(), &mut vbv_follow, why)?;
                            (width, height) = want;
                            wanted = None;
                            // Subscribers need an IDR at the new size to decode anything at all.
                            rebuild_idr = true;
                            continue; // next tick captures at the new canvas
                        }
                    }
                }
                if !have_frame {
                    // Nothing captured yet. Advance the schedule anyway, or `due` stays in the past
                    // and the sleep above never fires — polling WGC flat out on a whole core, in
                    // the process whose entire job is not to take the game's CPU. Reachable for a
                    // real stretch: a window that isn't drawing (minimised, occluded) delivers no
                    // frame at all until the app gives up on us.
                    idx += 1;
                    continue;
                }
            }
            None => nv12::test_pattern_into(width as usize, height as usize, idx, &mut cur),
        }
        let packets = match enc.encode(&cur, idx as i64 * frame_us, frame_us, force_key) {
            Ok(p) => {
                consecutive_errors = 0;
                p
            }
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors >= MAX_CONSECUTIVE_ENCODE_ERRORS {
                    // Named: a machine can offer several encoders and the report is read without
                    // any way to ask which one was in play.
                    let which = enc.name().to_string();
                    bail!("{which} failed {consecutive_errors} frames in a row: {e:#}");
                }
                log::warn!("encode error (continuing): {e:#}");
                Vec::new()
            }
        };
        stats.fed += 1;
        let delivered = !packets.is_empty();
        let mut unanswered = false;
        for p in packets {
            unanswered |= keyframe_watch.delivered(p.keyframe);
            stats.encoded(p.keyframe, p.data.len());
            if held.is_none() && pump_timing::holds_for_same_ms_pair(handoffs, dev.same_ms_every) {
                held = Some(p);
                continue;
            }
            let wait = pump_timing::handoff_wait(last_handoff.map(|t| t.elapsed()));
            if !wait.is_zero() {
                std::thread::sleep(wait);
            }
            // A held frame goes out right before this one, inside the same millisecond.
            for q in held.take().into_iter().chain(std::iter::once(p)) {
                stats.sent += 1;
                stats.bytes += q.data.len();
                hand_over(&source, codec, &q, width, height);
                handoffs += 1;
            }
            last_handoff = Some(std::time::Instant::now());
        }
        if unanswered {
            log::warn!("{} ignored a keyframe request for 10 frames; rebuilding it", enc.name());
            let why = "rebuilding an encoder that ignored a keyframe request";
            enc = spec.rebuild(enc, (width, height), rate.applied(), &mut vbv_follow, why)?;
            // A fresh MFT opens with an IDR; asking for one makes sure of it.
            rebuild_idr = true;
        }
        if delivered {
            if let Some(tx) = ready.take() {
                let _ = tx.send(enc.name().to_string());
            }
        }
        idx += 1;

        if last_report.elapsed() >= Duration::from_secs(1) {
            let secs = last_report.elapsed().as_secs_f64();
            log::info!("{}", stats.describe(secs, (width, height), rate.applied(), last_estimate));
            // An encoder can also fail without ever erroring: keep accepting frames and simply
            // stop producing. `fed` climbs, `sent` sits at 0, viewers hold the last picture and
            // nobody is told — so the same silence the report prints is what we act on. Only after
            // the encoder has proven itself once, or a slow first frame would trip it.
            if ready.is_none() {
                if stats.sent == 0 {
                    silent_reports += 1;
                    if silent_reports >= MAX_SILENT_REPORTS {
                        bail!(
                            "{} accepted {} frames but produced nothing for {silent_reports}s",
                            enc.name(),
                            stats.fed
                        );
                    }
                } else {
                    silent_reports = 0;
                }
            }
            stats = pump_stats::PumpStats::default();
            last_report = std::time::Instant::now();
        }
    }
    Ok(())
}

/// Hands one encoded access unit to livekit.
#[cfg(windows)]
fn hand_over(
    source: &NativeVideoSource,
    codec: EncodedVideoCodec,
    p: &EncodedPacket,
    width: u32,
    height: u32,
) {
    let ev = EncodedVideoFrame {
        codec,
        payload: &p.data,
        timestamp_us: p.timestamp_us,
        frame_type: if p.keyframe { EncodedFrameType::Key } else { EncodedFrameType::Delta },
        resolution: VideoResolution { width, height },
        frame_metadata: None,
    };
    source.capture_encoded_frame(&ev);
}

/// Feeds an animated I420 test pattern into the source at `fps`.
///
/// The pattern is deliberately busy and moving so a viewer can tell decryption
/// worked at a glance: a horizontal luma gradient, three static chroma colour
/// columns, and a white band that scrolls down the frame each tick. A wrong key
/// yields noise/green instead.
async fn frame_pump(source: NativeVideoSource, width: u32, height: u32, fps: u32) {
    let w = width as usize;
    let h = height as usize;
    let cw = ((width + 1) / 2) as usize;
    let ch = ((height + 1) / 2) as usize;
    let frame_interval_us = 1_000_000i64 / fps as i64;
    let band_h = (h / 10).max(1);

    let mut interval = tokio::time::interval(Duration::from_micros(frame_interval_us as u64));
    let mut frame_idx: i64 = 0;

    loop {
        interval.tick().await;

        let mut buffer = I420Buffer::new(width, height);
        let (stride_y, stride_u, stride_v) = buffer.strides();
        let (data_y, data_u, data_v) = buffer.data_mut();
        let (sy, su, sv) = (stride_y as usize, stride_u as usize, stride_v as usize);

        // Luma: horizontal gradient 40..255.
        for y in 0..h {
            let row = &mut data_y[y * sy..y * sy + w];
            for (x, px) in row.iter_mut().enumerate() {
                *px = (40 + (x * 215 / w.max(1))) as u8;
            }
        }
        // Scrolling white band — the obvious "this is live" signal.
        let band_start = ((frame_idx as usize) * 4) % h;
        for y in band_start..(band_start + band_h).min(h) {
            for px in &mut data_y[y * sy..y * sy + w] {
                *px = 235;
            }
        }
        // Chroma: three static colour columns (left/mid/right).
        for cy in 0..ch {
            for cx in 0..cw {
                let (u, v) = match cx * 3 / cw.max(1) {
                    0 => (240u8, 110u8), // blue-ish
                    1 => (90, 240),      // red-ish
                    _ => (110, 90),      // green-ish
                };
                data_u[cy * su + cx] = u;
                data_v[cy * sv + cx] = v;
            }
        }

        let frame = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: frame_idx * frame_interval_us,
            frame_metadata: None,
            buffer,
        };
        source.capture_frame(&frame);
        frame_idx += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::canvas_for;

    /// The app shows no error for this exit and an error for every other — so the source going away
    /// must be recognised however much context was wrapped around it on the way out.
    #[test]
    fn should_recognise_a_vanished_source_through_added_context() {
        use super::{is_source_gone, SourceGone};
        use anyhow::Context;
        let wrapped: anyhow::Result<()> = Err(anyhow::Error::new(SourceGone)).context("capturing");
        assert!(is_source_gone(&wrapped.unwrap_err()));
        assert!(!is_source_gone(&anyhow::anyhow!("the encoder died")));
    }

    #[test]
    fn should_turn_the_dev_switches_on_when_they_hold_common_truthy_values() {
        use super::DevHarness;

        for on in ["1", "true", " YES ", "on"] {
            let dev = DevHarness::from_values(Some("90"), Some(on), Some(on));
            let all_on = DevHarness {
                same_ms_every: 90,
                ignore_keyframe_requests: true,
                one_encoder_session: true,
            };
            assert_eq!(dev, all_on, "{on}");
        }
    }

    #[test]
    fn should_keep_the_dev_switches_off_when_a_value_cannot_be_read() {
        use super::DevHarness;
        let off = DevHarness {
            same_ms_every: 0,
            ignore_keyframe_requests: false,
            one_encoder_session: false,
        };

        // A bad value must never stop the helper from starting — it switches the harness off.
        assert_eq!(DevHarness::from_values(Some("ninety"), Some("maybe"), Some("2")), off);
        assert_eq!(DevHarness::from_values(Some("-5"), Some("0"), Some("off")), off);
        assert_eq!(DevHarness::from_values(None, None, None), off);
    }

    const CAP_720: (u32, u32) = (1280, 720);
    const CAP_1080: (u32, u32) = (1920, 1080);

    #[test]
    fn should_reserve_a_bitrate_a_game_can_actually_use() {
        use super::target_bitrate;
        // The bug this replaces: the SDK budgeted our single stream as a 320x240 simulcast layer,
        // a flat 150 kbps for a 1080p game. Whatever we ask for, it must not be near that.
        assert!(target_bitrate(1920, 1080, 30) > 5_000_000, "1080p30 needs Mbps, not kbps");
        assert!(target_bitrate(1280, 720, 30) > 2_000_000);
        // Bounded at both ends: a tiny window still gets a usable floor, 4K a sane ceiling.
        assert_eq!(target_bitrate(320, 240, 30), 1_500_000);
        assert_eq!(target_bitrate(3840, 2160, 60), 12_000_000);
    }

    #[test]
    fn should_shrink_a_source_that_exceeds_the_cap() {
        // The live case: a 1440p monitor while the setting says 720p. This is what the app asked
        // for and the helper used to ignore entirely.
        assert_eq!(canvas_for(2560, 1440, CAP_720), (1280, 720));
        assert_eq!(canvas_for(2560, 1440, CAP_1080), (1920, 1080));
    }

    #[test]
    fn should_never_upscale_a_source_smaller_than_the_cap() {
        assert_eq!(canvas_for(800, 600, CAP_720), (800, 600));
        assert_eq!(canvas_for(1280, 720, CAP_1080), (1280, 720));
    }

    #[test]
    fn should_keep_the_source_aspect_when_shrinking() {
        // 4:3 under a 16:9 cap is limited by height, not width.
        assert_eq!(canvas_for(1600, 1200, CAP_720), (960, 720));
        // An ultrawide is limited by width: 1280*1440/3440 = 535.8, floored to an even 534.
        assert_eq!(canvas_for(3440, 1440, CAP_720), (1280, 534));
    }

    #[test]
    fn should_stay_even_for_chroma_pairing() {
        let (w, h) = canvas_for(1001, 999, CAP_720);
        assert_eq!((w % 2, h % 2), (0, 0));
    }

    #[test]
    fn should_stream_the_source_size_when_there_is_no_cap() {
        let uncapped = (u32::MAX, u32::MAX);
        assert_eq!(canvas_for(2560, 1440, uncapped), (2560, 1440));
    }
}
