//! macOS share audio: ScreenCaptureKit audio, written to stdout in audio-capture.exe's format (MSC-03).
//!
//! The app already consumes that format on Windows: a 12-byte header (sample rate u32, channels
//! u16, bits per sample u16, format tag u32; all little-endian), then interleaved PCM. So the
//! renderer needs no mac path. Scoped like Windows: a window share sends only its application's
//! sound, a screen share everything except mqvi, whose own playback would echo the call back to the
//! people in it.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use screencapturekit::prelude::*;

/// What the stream is configured for, and what the header promises: 48 kHz stereo float32.
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;
/// `formatTag` 3 = IEEE float, as WAVE_FORMAT_IEEE_FLOAT on Windows.
const FORMAT_FLOAT: u32 = 3;
/// CoreAudio's kAudioFormatFlagIsNonInterleaved: one buffer per channel.
const NON_INTERLEAVED: u32 = 1 << 5;

/// Whose audio to send.
#[derive(Clone, Copy, Debug)]
pub enum AudioTarget {
    /// Everything except mqvi.
    AllButOurs,
    /// Everything except mqvi; the display only anchors the filter, audio is not per display.
    Display(u32),
    /// The application that owns this window, or everything but mqvi if that is mqvi itself.
    Window(u32),
}

/// The header audio-capture.exe writes before any PCM.
pub fn header(sample_rate: u32, channels: u16) -> [u8; 12] {
    let mut h = [0u8; 12];
    h[0..4].copy_from_slice(&sample_rate.to_le_bytes());
    h[4..6].copy_from_slice(&channels.to_le_bytes());
    h[6..8].copy_from_slice(&32u16.to_le_bytes());
    h[8..12].copy_from_slice(&FORMAT_FLOAT.to_le_bytes());
    h
}

/// Whether an application is mqvi: the app whose pid we were given, or one whose bundle id extends
/// its bundle id. Electron plays audio from helper processes ("<bundle>.helper",
/// "<bundle>.helper.Renderer"), not from the main process.
pub fn is_ours(pid: i32, bundle: &str, our_pid: i32, our_bundle: Option<&str>) -> bool {
    if pid == our_pid {
        return true;
    }
    match our_bundle {
        Some(b) if !b.is_empty() => bundle == b || bundle.strip_prefix(b).is_some_and(|rest| rest.starts_with('.')),
        _ => false,
    }
}

/// Planar float32 channels (one byte slice each, native endian) → interleaved little-endian bytes,
/// shaped to `out_channels`: a mono source is duplicated, extra source channels are dropped.
pub fn interleave(planes: &[&[u8]], out_channels: usize) -> Vec<u8> {
    let frames = planes.iter().map(|p| p.len() / 4).min().unwrap_or(0);
    let mut out = Vec::with_capacity(frames * out_channels * 4);
    for i in 0..frames {
        for ch in 0..out_channels {
            let plane = planes.get(ch).or(planes.last());
            let sample = plane.map_or(0.0, |p| f32::from_ne_bytes([p[i * 4], p[i * 4 + 1], p[i * 4 + 2], p[i * 4 + 3]]));
            out.extend_from_slice(&sample.to_le_bytes());
        }
    }
    out
}

/// Interleaved float32 (native endian) with `in_channels` → interleaved little-endian bytes with
/// `out_channels`.
pub fn reshape_interleaved(data: &[u8], in_channels: usize, out_channels: usize) -> Vec<u8> {
    let in_channels = in_channels.max(1);
    let frames = data.len() / 4 / in_channels;
    let mut out = Vec::with_capacity(frames * out_channels * 4);
    for i in 0..frames {
        for ch in 0..out_channels {
            let at = (i * in_channels + ch.min(in_channels - 1)) * 4;
            let sample = f32::from_ne_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]);
            out.extend_from_slice(&sample.to_le_bytes());
        }
    }
    out
}

/// Captures until stdin closes (the app's stop) or the stream ends, writing the header and then PCM
/// to stdout. `our_pid` is the app's main process, whose applications are left out.
pub fn run(target: AudioTarget, our_pid: Option<i32>) -> Result<()> {
    // A window or app filter needs a window-server connection; see mac_capture::Source::find.
    let _ = apple_cf::cg::Display::main();
    let content = SCShareableContent::get().map_err(|e| anyhow!("listing shareable content: {e}"))?;
    let apps = content.applications();
    let our_bundle = our_pid
        .and_then(|pid| apps.iter().find(|a| a.process_id() == pid))
        .map(|a| a.bundle_identifier());
    let ours: Vec<&SCRunningApplication> = match our_pid {
        Some(pid) => apps
            .iter()
            .filter(|a| is_ours(a.process_id(), &a.bundle_identifier(), pid, our_bundle.as_deref()))
            .collect(),
        None => Vec::new(),
    };
    // Which of mqvi's processes ScreenCaptureKit lists is what decides whether the call can echo.
    log::info!(
        "audio: leaving out {} app(s) of ours ({}): {}",
        ours.len(),
        our_bundle.as_deref().unwrap_or("no bundle found"),
        ours.iter().map(|a| format!("{} [{}]", a.application_name(), a.process_id())).collect::<Vec<_>>().join(", ")
    );

    let displays = content.displays();
    let main_display = displays
        .iter()
        .find(|d| d.frame().origin.x == 0.0 && d.frame().origin.y == 0.0)
        .or_else(|| displays.first())
        .context("no display to anchor the audio filter")?;
    let all_but_ours = |display: &SCDisplay| SCContentFilter::create().with_display(display).with_excluding_applications(&ours, &[]);

    let builder = match target {
        AudioTarget::AllButOurs => all_but_ours(main_display),
        AudioTarget::Display(id) => {
            let display = displays.iter().find(|d| d.display_id() == id).unwrap_or(main_display);
            all_but_ours(display)
        }
        AudioTarget::Window(id) => {
            let windows = content.windows();
            let owner = windows.iter().find(|w| w.window_id() == id).and_then(|w| w.owning_application());
            match owner {
                // Our own window: including our tree is the echo loop. Same fallback as Windows.
                Some(app) if !is_ours(app.process_id(), &app.bundle_identifier(), our_pid.unwrap_or(-1), our_bundle.as_deref()) => {
                    log::info!("audio: only {} [{}]", app.application_name(), app.process_id());
                    SCContentFilter::create().with_display(main_display).with_including_applications(&[&app], &[])
                }
                Some(_) => {
                    log::info!("audio: window {id} is ours; sending everything but mqvi");
                    all_but_ours(main_display)
                }
                None => {
                    log::info!("audio: window {id} has no owner we can see; sending everything but mqvi");
                    all_but_ours(main_display)
                }
            }
        }
    };
    let filter = builder.build().map_err(|e| anyhow!("building the audio filter: {e}"))?;

    let config = SCStreamConfiguration::new()
        .with_captures_audio(true)
        .with_sample_rate(SAMPLE_RATE as i32)
        .with_channel_count(i32::from(CHANNELS))
        .with_excludes_current_process_audio(true)
        // Audio only: the video side is the smallest the stream takes, at a frame a second, and has
        // no output handler.
        .with_width(16)
        .with_height(16)
        .with_fps(1);

    // The header goes out first, before any audio: the app waits for it, and a share with nothing
    // playing may not deliver a buffer for a while.
    let out = Arc::new(Mutex::new(std::io::stdout()));
    {
        let mut o = out.lock().map_err(|_| anyhow!("stdout lock poisoned"))?;
        o.write_all(&header(SAMPLE_RATE, CHANNELS)).context("writing the audio header")?;
        o.flush().context("flushing the audio header")?;
    }

    // Whatever ends the capture first: None is the app closing our stdin (its stop), Some is the
    // stream or stdout failing, with why.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<Option<String>>();
    let mut stream = SCStream::new_with_delegate(&filter, &config, AudioStopWatch { done: Mutex::new(Some(done_tx.clone())) })
        .map_err(|e| anyhow!("creating the audio stream: {e}"))?;
    stream
        .add_output_handler(
            AudioOut { out, done: Mutex::new(Some(done_tx.clone())), warned: Mutex::new(false) },
            SCStreamOutputType::Audio,
        )
        .map_err(|e| anyhow!("adding the audio handler: {e}"))?;
    stream.start_capture().map_err(|e| anyhow!("starting the audio stream: {e}"))?;
    log::info!("audio: capturing at {SAMPLE_RATE} Hz, {CHANNELS} channels");

    // Not joined: a blocking stdin read cannot be cancelled, and the process exits right after.
    std::thread::spawn(move || {
        let mut buf = [0u8; 64];
        let mut stdin = std::io::stdin();
        while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
        let _ = done_tx.send(None);
    });
    let why = done_rx.recv().unwrap_or(None);
    if let Err(e) = stream.stop_capture() {
        log::warn!("audio: stopping the stream: {e}");
    }
    match why {
        Some(w) => Err(anyhow!(w)),
        None => Ok(()),
    }
}

struct AudioOut {
    out: Arc<Mutex<std::io::Stdout>>,
    /// Told when stdout is gone: the app closed the pipe, so there is no one to write for.
    done: Mutex<Option<std::sync::mpsc::Sender<Option<String>>>>,
    /// An unusable format is said once, not once per buffer.
    warned: Mutex<bool>,
}

impl AudioOut {
    fn warn_once(&self, what: &str) {
        if let Ok(mut w) = self.warned.lock() {
            if !*w {
                log::warn!("audio: {what}; dropping buffers");
                *w = true;
            }
        }
    }
}

impl SCStreamOutputTrait for AudioOut {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if !matches!(of_type, SCStreamOutputType::Audio) {
            return;
        }
        let Some(format) = sample.format_description() else { return };
        if !format.audio_is_float() || format.audio_bits_per_channel() != Some(32) {
            self.warn_once(&format!("not float32 (bits {:?}, flags {:?})", format.audio_bits_per_channel(), format.audio_format_flags()));
            return;
        }
        if format.audio_sample_rate().map(|r| r as u32) != Some(SAMPLE_RATE) {
            self.warn_once(&format!("sample rate {:?}, not {SAMPLE_RATE}", format.audio_sample_rate()));
            return;
        }
        let channels = format.audio_channel_count().unwrap_or(1).max(1) as usize;
        let planar = format.audio_format_flags().is_some_and(|f| f & NON_INTERLEAVED != 0);
        let Ok(list) = sample.audio_buffer_list() else { return };
        let bytes = if planar {
            let planes: Vec<&[u8]> = list.iter().map(|b| b.data()).collect();
            interleave(&planes, CHANNELS as usize)
        } else {
            match list.iter().next() {
                Some(b) => reshape_interleaved(b.data(), channels, CHANNELS as usize),
                None => return,
            }
        };
        if bytes.is_empty() {
            return;
        }
        let written = self.out.lock().map(|mut o| o.write_all(&bytes).and_then(|()| o.flush()).is_ok()).unwrap_or(false);
        if !written {
            if let Some(tx) = self.done.lock().ok().and_then(|mut e| e.take()) {
                let _ = tx.send(Some("stdout closed".into()));
            }
        }
    }
}

struct AudioStopWatch {
    done: Mutex<Option<std::sync::mpsc::Sender<Option<String>>>>,
}

impl SCStreamDelegateTrait for AudioStopWatch {
    fn did_stop_with_error(&self, error: SCError) {
        if let Some(tx) = self.done.lock().ok().and_then(|mut e| e.take()) {
            let _ = tx.send(Some(format!("audio stream stopped: {error}")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32s(bytes: &[u8]) -> Vec<f32> {
        bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
    }

    fn plane(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_ne_bytes()).collect()
    }

    #[test]
    fn should_write_the_header_audio_capture_exe_writes() {
        // 48000 Hz, 2 channels, 32 bits, IEEE float (3): the layout electron/main.ts parses.
        assert_eq!(header(48_000, 2), [0x80, 0xBB, 0, 0, 2, 0, 32, 0, 3, 0, 0, 0]);
    }

    #[test]
    fn should_interleave_planar_channels() {
        let (l, r) = (plane(&[1.0, 2.0, 3.0]), plane(&[-1.0, -2.0, -3.0]));
        assert_eq!(f32s(&interleave(&[&l, &r], 2)), vec![1.0, -1.0, 2.0, -2.0, 3.0, -3.0]);
    }

    #[test]
    fn should_duplicate_a_mono_plane_into_both_channels() {
        let m = plane(&[0.5, 0.25]);
        assert_eq!(f32s(&interleave(&[&m], 2)), vec![0.5, 0.5, 0.25, 0.25]);
    }

    #[test]
    fn should_stop_at_the_shortest_plane() {
        let (l, r) = (plane(&[1.0, 2.0]), plane(&[9.0]));
        assert_eq!(f32s(&interleave(&[&l, &r], 2)), vec![1.0, 9.0]);
    }

    #[test]
    fn should_reshape_interleaved_mono_to_stereo() {
        assert_eq!(f32s(&reshape_interleaved(&plane(&[0.1, 0.2]), 1, 2)), vec![0.1, 0.1, 0.2, 0.2]);
    }

    #[test]
    fn should_count_electron_helpers_as_ours() {
        let ours = |pid, bundle| is_ours(pid, bundle, 100, Some("com.mqvi.app"));
        assert!(ours(100, "com.mqvi.app"));
        assert!(ours(101, "com.mqvi.app.helper"));
        assert!(ours(102, "com.mqvi.app.helper.Renderer"));
        // A different app that merely shares the prefix is not ours.
        assert!(!ours(200, "com.mqvi.application"));
        assert!(!ours(201, "com.google.Chrome"));
    }

    #[test]
    fn should_match_by_pid_alone_when_no_bundle_is_known() {
        assert!(is_ours(100, "", 100, None));
        assert!(!is_ours(101, "com.mqvi.app.helper", 100, None));
        assert!(!is_ours(101, "anything", 100, Some("")));
    }
}
