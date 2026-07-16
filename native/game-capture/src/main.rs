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

use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use livekit::e2ee::key_provider::{KeyProvider, KeyProviderOptions};
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::options::{TrackPublishOptions, VideoCodec};
use livekit::track::{LocalTrack, LocalVideoTrack, TrackSource};
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::{Room, RoomEvent, RoomOptions};

/// NGC-01 spike: publish a synthetic E2EE video track to a LiveKit room.
#[derive(Parser, Debug)]
#[command(name = "mqvi-game-capture", version, about)]
struct Args {
    /// LiveKit server URL (from the screen-token response `url`).
    #[arg(long, env = "LK_URL")]
    url: String,

    /// LiveKit access token for the "{userId}_ss" identity (screen-token `token`).
    #[arg(long, env = "LK_TOKEN")]
    token: String,

    /// Room E2EE passphrase (screen-token `e2eePassphrase`). Must equal what the
    /// app clients passed to ExternalE2EEKeyProvider.setKey for this room.
    #[arg(long, env = "LK_E2EE_KEY")]
    e2ee_key: String,

    /// Frame width (kept even for I420 chroma subsampling).
    #[arg(long, default_value_t = 1280)]
    width: u32,

    /// Frame height (kept even for I420 chroma subsampling).
    #[arg(long, default_value_t = 720)]
    height: u32,

    /// Frames per second for the synthetic source.
    #[arg(long, default_value_t = 30)]
    fps: u32,
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
    let width = args.width & !1; // force even
    let height = args.height & !1;
    let fps = args.fps.max(1);

    // E2EE: shared-key provider seeded with the room passphrase. Defaults give
    // salt="LKFrameEncryptionKey" + PBKDF2, matching the JS ExternalE2EEKeyProvider.
    let key_provider =
        KeyProvider::with_shared_key(KeyProviderOptions::default(), args.e2ee_key.into_bytes());

    let mut room_options = RoomOptions::default();
    room_options.encryption = Some(E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider });
    // We only publish; no need to subscribe to anyone in this spike.
    room_options.auto_subscribe = false;

    log::info!("connecting to {}", args.url);
    let (room, mut events) = Room::connect(&args.url, &args.token, room_options)
        .await
        .context("LiveKit connect failed (check url/token/network)")?;
    let local = room.local_participant();
    log::info!(
        "connected as identity={} room={}",
        local.identity().as_str(),
        room.name()
    );

    // Synthetic screen-cast source. is_screencast=true tells the SFU/encoder this is
    // screen content (favours resolution over framerate on constrained links).
    let rtc_source = NativeVideoSource::new(VideoResolution { width, height }, true);
    let track = LocalVideoTrack::create_video_track(
        "native-game-capture",
        RtcVideoSource::Native(rtc_source.clone()),
    );

    let mut publish_opts = TrackPublishOptions::default();
    publish_opts.source = TrackSource::Screenshare;
    // VP8 for the spike: universally decodable by every app client, no simulcast setup.
    // NGC-02 swaps this for NVENC-encoded H265/H264.
    publish_opts.video_codec = VideoCodec::VP8;

    local
        .publish_track(LocalTrack::Video(track), publish_opts)
        .await
        .context("publish_track failed")?;
    log::info!("published track 'native-game-capture' ({width}x{height}@{fps}, VP8, E2EE/GCM)");

    // Drive the synthetic source on its own task so the event loop stays responsive.
    let pump = tokio::spawn(frame_pump(rtc_source, width, height, fps));

    println!("Publishing encrypted test pattern. Watch the app client render it. Ctrl+C to stop.");

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                log::info!("ctrl-c — shutting down");
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

    pump.abort();
    room.close().await.ok();
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
