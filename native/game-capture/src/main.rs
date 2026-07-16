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
use livekit::options::{TrackPublishOptions, VideoCodec};
use livekit::track::{LocalTrack, LocalVideoTrack, TrackSource};
use livekit::webrtc::rtp_sender::VideoEncoderBackend;
use livekit::webrtc::video_frame::{
    EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame, I420Buffer, VideoFrame, VideoRotation,
};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::{Room, RoomEvent, RoomOptions};
use mqvi_game_capture::capture::ScreenCapture;
use mqvi_game_capture::mf_encoder::HwEncoder;
use mqvi_game_capture::nv12;
use tokio::sync::oneshot;

/// Consecutive encode failures that mean the encoder is gone for good, not glitching (1s at 30fps).
const MAX_CONSECUTIVE_ENCODE_ERRORS: u32 = 30;
/// Seconds of "accepting frames, producing nothing" that mean the same. Encoder death has three
/// shapes — erroring, silent, and hung — and this is the silent one. (Hung is bounded inside
/// HwEncoder::encode, which turns it into an error and lands on the counter above.)
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

    /// LiveKit server URL (from the screen-token response `url`).
    #[arg(long, env = "LK_URL", required_unless_present = "config_stdin")]
    url: Option<String>,

    /// LiveKit access token for the "{userId}_ss" identity (screen-token `token`).
    #[arg(long, env = "LK_TOKEN", required_unless_present = "config_stdin")]
    token: Option<String>,

    /// Room E2EE passphrase (screen-token `e2eePassphrase`). Must equal what the
    /// app clients passed to ExternalE2EEKeyProvider.setKey for this room.
    #[arg(long, env = "LK_E2EE_KEY", required_unless_present = "config_stdin")]
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

/// "x,y,width,height" → (x, y, width, height).
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
    Wgc,
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
            rt.block_on(run())
        })
        .context("failed to spawn worker thread")?;
    handle.join().map_err(|_| anyhow::anyhow!("worker thread panicked"))?
}

async fn run() -> Result<()> {
    // RUST_LOG=livekit=debug surfaces the SDK's connection/E2EE internals.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args = Args::parse();
    // Read before anything slow: the app writes this line right after spawning us.
    let conn = Connection::resolve(&args)?;
    let mut width = args.width & !1; // force even
    let mut height = args.height & !1;
    let fps = args.fps.max(1);

    // WGC capture: dimensions come from the source (window or monitor), and it goes through our MF
    // encoder. The app addresses its picked source exactly (--window-handle / --monitor-rect); the
    // title and primary-monitor forms are dev conveniences.
    let capture = if let Some(handle) = args.window_handle {
        let cap = ScreenCapture::window_by_handle(handle)?;
        width = cap.width() & !1;
        height = cap.height() & !1;
        log::info!("WGC window capture hwnd={handle}: {width}x{height}");
        Some(cap)
    } else if let Some(rect) = &args.monitor_rect {
        let (x, y, w, h) = parse_rect(rect)?;
        let cap = ScreenCapture::monitor_by_rect(x, y, w, h)?;
        width = cap.width() & !1;
        height = cap.height() & !1;
        log::info!("WGC monitor capture at {x},{y}: {width}x{height}");
        Some(cap)
    } else if let Some(title) = &args.window {
        let cap = ScreenCapture::window_by_title(title)?;
        width = cap.width() & !1;
        height = cap.height() & !1;
        log::info!("WGC window capture '{title}': {width}x{height}");
        Some(cap)
    } else if args.source == Source::Wgc {
        let cap = ScreenCapture::primary_monitor()?;
        width = cap.width() & !1;
        height = cap.height() & !1;
        log::info!("WGC monitor capture: {width}x{height}");
        Some(cap)
    } else {
        None
    };

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

    let use_mf = args.encoder == Encoder::Mf || capture.is_some();
    // WGC always hardware-encodes; default a wgc run (codec would otherwise be vp8) to h264.
    let codec = if capture.is_some() && !matches!(args.codec, Codec::H264 | Codec::H265) {
        Codec::H264
    } else {
        args.codec
    };
    let hevc = matches!(codec, Codec::H265);
    if use_mf && !matches!(codec, Codec::H264 | Codec::H265) {
        bail!("hardware encode (--encoder mf) needs --codec h264 or h265");
    }

    // MF path hands livekit pre-encoded access units (new_encoded); otherwise a raw I420
    // source that libwebrtc encodes itself (is_screencast=true = screen content hint).
    let res = VideoResolution { width, height };
    let rtc_source = if use_mf {
        NativeVideoSource::new_encoded(res)
    } else {
        NativeVideoSource::new(res, true)
    };
    let track = LocalVideoTrack::create_video_track(
        "native-game-capture",
        RtcVideoSource::Native(rtc_source.clone()),
    );

    let backends: Vec<_> = VideoEncoderBackend::list_available().into_iter().collect();
    log::info!("available encoder backends: {backends:?}");

    let mut publish_opts = TrackPublishOptions::default();
    publish_opts.source = TrackSource::Screenshare;
    publish_opts.video_codec = codec.to_lk();
    // We hand livekit already-encoded frames on the MF path → PreEncoded pass-through (no re-encode).
    publish_opts.video_encoder = if use_mf {
        VideoEncoderBackend::PreEncoded
    } else {
        args.encoder.to_lk()
    };

    local
        .publish_track(LocalTrack::Video(track), publish_opts)
        .await
        .context("publish_track failed")?;
    log::info!(
        "published track 'native-game-capture' ({width}x{height}@{fps}, codec={:?}, hw_encode={}, source={:?}, E2EE/GCM)",
        codec, use_mf, args.source
    );

    // MF encoding does blocking COM calls → dedicated OS thread. Raw path → tokio task.
    let stop = Arc::new(AtomicBool::new(false));
    // `ready` fires on the first frame the encoder actually delivers; `died` on a fatal encode
    // failure. The hardware encoder is created inside the pump and can fail outright (no MFT on
    // this machine) or die later (a GPU driver reset — routine for our workload, a fullscreen
    // game), and neither shows up as a process exit.
    let (ready_tx, ready_rx) = oneshot::channel::<String>();
    let (died_tx, mut died_rx) = oneshot::channel::<String>();
    let cfg = VideoConfig { width, height, fps, hevc };
    let mf_thread = if use_mf {
        let (src, stop) = (rtc_source.clone(), stop.clone());
        Some(std::thread::spawn(move || {
            if let Err(e) = encoded_pump(src, cfg, capture, stop, ready_tx) {
                log::error!("encode thread failed: {e:#}");
                let _ = died_tx.send(format!("{e:#}"));
            }
        }))
    } else {
        None
    };
    let raw_pump = (!use_mf).then(|| tokio::spawn(frame_pump(rtc_source, width, height, fps)));

    // "Published" is not "streaming": the track exists, but nothing is on it until the encoder
    // delivers. Announcing readiness before that is how a machine with no hardware encoder ends up
    // with the app committed to a stream that stays black forever.
    let mut startup_error = None;
    let mut streaming = !use_mf;
    if use_mf {
        tokio::select! {
            first = ready_rx => match first {
                Ok(encoder) => {
                    log::info!("encoding with {encoder}");
                    streaming = true;
                }
                // Sender dropped: the pump bailed before delivering anything.
                Err(_) => startup_error = Some(anyhow!("the hardware encoder produced no frames")),
            },
            _ = &mut stop_signal => log::info!("asked to stop before the first frame"),
        }
    }

    if streaming {
        // The app waits for exactly this line before it commits to the native engine.
        println!("MQVI-READY");

        loop {
            tokio::select! {
                _ = &mut stop_signal => {
                    log::info!("shutting down");
                    break;
                }
                reason = &mut died_rx => {
                    // Exiting is the only way the app learns: it watches for our process to end.
                    log::error!("encoder stopped: {reason:?}");
                    startup_error = Some(anyhow!("encoder stopped mid-stream"));
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

    stop.store(true, Ordering::Relaxed);
    if let Some(p) = raw_pump {
        p.abort();
    }
    // Joining matters: the pump owns `capture`, so this is where the WGC session gets closed.
    if let Some(t) = mf_thread {
        let _ = t.join();
    }
    room.close().await.ok();
    match startup_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// What the pump encodes: frame geometry and codec, settled before it starts.
#[derive(Clone, Copy)]
struct VideoConfig {
    width: u32,
    height: u32,
    fps: u32,
    hevc: bool,
}

/// MF hardware-encode pump (dedicated OS thread): NV12 (synthetic or WGC-captured screen) →
/// hardware H264/H265 → livekit PreEncoded. Blocking encode() lives off the tokio runtime.
fn encoded_pump(
    source: NativeVideoSource,
    cfg: VideoConfig,
    mut capture: Option<ScreenCapture>,
    stop: Arc<AtomicBool>,
    ready: oneshot::Sender<String>,
) -> Result<()> {
    let VideoConfig { width, height, fps, hevc } = cfg;
    // Start conservative — WebRTC's rate-control feedback ramps it up to what the link allows.
    // (Starting high floods the pipe before the first estimate arrives → initial corruption.)
    let bitrate = if capture.is_some() { 2_500_000 } else { 6_000_000 };
    HwEncoder::startup()?;
    let mut enc = HwEncoder::new(width, height, fps, bitrate, hevc)?;
    log::info!("hardware encoder: {}", enc.name());

    let codec = if hevc { EncodedVideoCodec::H265 } else { EncodedVideoCodec::H264 };
    let frame_us = 1_000_000i64 / fps as i64;
    let (w, h) = (width as usize, height as usize);
    let mut idx: u64 = 0;
    let t0 = std::time::Instant::now();
    // For WGC: the latest NV12 frame, reused when no new WGC frame arrived (static screen) so the
    // stream holds `fps`. `have_frame` guards the first ticks before any frame is captured.
    let mut cur = Vec::new();
    let mut have_frame = false;

    // Delivery stats reported once a second: fed = frames we tried to encode, sent = encoded
    // packets handed to livekit, plus their bitrate. Tells us if the pump keeps ~fps or stalls.
    let mut fed = 0u32;
    let mut sent = 0u32;
    let mut bytes = 0usize;
    let mut last_report = std::time::Instant::now();
    // WebRTC bandwidth estimate: collected every tick, applied at most once a second. Reconfiguring
    // the hardware encoder ~30x/s (with an oscillating estimate) makes it emit undecodable frames.
    let mut pending_bitrate = 0u32;
    let mut applied_bitrate = bitrate;
    // Announced once, on the first frame the encoder really delivers.
    let mut ready = Some(ready);
    // A transient encode error must not kill the stream, but a dead MFT (driver reset) fails every
    // frame forever — without a limit the app sees a live helper and viewers a frozen picture.
    let mut consecutive_errors = 0u32;
    // The other half of that: an encoder can stop delivering without ever returning an error.
    let mut silent_reports = 0u32;

    while !stop.load(Ordering::Relaxed) {
        // Absolute schedule: frame idx is due at t0 + idx*frame_us. Sleeping to an absolute target
        // (not interval-minus-work) keeps delivery even — relative sleeps accumulate drift/jitter
        // when encode() takes a variable time, which shows as the stream stretching then snapping.
        let due = t0 + Duration::from_micros(idx * frame_us as u64);
        if let Some(d) = due.checked_duration_since(std::time::Instant::now()) {
            std::thread::sleep(d);
        }

        // The SFU raises a keyframe request (PLI/FIR) when a subscriber needs an IDR — e.g. after
        // packet loss, so the decoder recovers instead of ghosting. Force one this frame.
        let force_key = source.take_keyframe_request();
        if force_key {
            log::info!("keyframe requested — forcing IDR");
        }
        // Follow WebRTC's bandwidth estimate so the encoder doesn't flood the link (blocky
        // corruption). Just record it here; apply at most once/second below.
        if let Some(rc) = source.take_rate_control_request() {
            pending_bitrate = (rc.target_bitrate_bps as u32).clamp(800_000, 20_000_000);
        }

        // Frame source: real screen (reuse last on no-change) or the synthetic pattern. Both
        // convert into `cur`, which is kept across frames — see nv12::bgra_to_nv12_into.
        match &mut capture {
            Some(cap) => {
                if let Some(f) = cap.next_frame() {
                    nv12::bgra_to_nv12_into(f.data, w, h, f.stride, &mut cur);
                    have_frame = true;
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
            None => nv12::test_pattern_into(w, h, idx, &mut cur),
        }
        let packets = match enc.encode(&cur, idx as i64 * frame_us, frame_us, force_key) {
            Ok(p) => {
                consecutive_errors = 0;
                p
            }
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors >= MAX_CONSECUTIVE_ENCODE_ERRORS {
                    bail!("hardware encoder failed {consecutive_errors} frames in a row: {e:#}");
                }
                log::warn!("encode error (continuing): {e:#}");
                Vec::new()
            }
        };
        fed += 1;
        let delivered = !packets.is_empty();
        for p in packets {
            sent += 1;
            bytes += p.data.len();
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
        if delivered {
            if let Some(tx) = ready.take() {
                let _ = tx.send(enc.name().to_string());
            }
        }
        idx += 1;

        if last_report.elapsed() >= Duration::from_secs(1) {
            // Apply the latest bandwidth estimate at most once/second.
            if pending_bitrate != 0 && pending_bitrate != applied_bitrate {
                enc.set_bitrate(pending_bitrate);
                applied_bitrate = pending_bitrate;
                log::info!("bitrate → {} kbps", pending_bitrate / 1000);
            }
            let secs = last_report.elapsed().as_secs_f64();
            log::info!(
                "encode: fed {:.1} fps, sent {:.1} fps, {:.0} kbps",
                fed as f64 / secs,
                sent as f64 / secs,
                (bytes as f64 * 8.0 / 1000.0) / secs
            );
            // An encoder can also fail without ever erroring: keep accepting frames and simply
            // stop producing. `fed` climbs, `sent` sits at 0, viewers hold the last picture and
            // nobody is told — so the same silence the report prints is what we act on. Only after
            // the encoder has proven itself once, or a slow first frame would trip it.
            if ready.is_none() {
                if sent == 0 {
                    silent_reports += 1;
                    if silent_reports >= MAX_SILENT_REPORTS {
                        bail!("encoder accepted {fed} frames but produced nothing for {silent_reports}s");
                    }
                } else {
                    silent_reports = 0;
                }
            }
            fed = 0;
            sent = 0;
            bytes = 0;
            last_report = std::time::Instant::now();
        }
    }
    Ok(())
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
