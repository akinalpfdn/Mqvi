//! macOS: drives the ScreenCaptureKit capture with no room, for a set time, and logs what arrives.
//!
//! The same capture the helper ships (`mac_capture`), feeding a video source nothing subscribes to.
//! It answers what a share cannot be started to find out: whether Screen Recording is granted (and
//! how a refusal looks), the real pixel size of a frame, and how many new frames a static and a
//! moving screen produce.
//!
//! Usage: `probe-sck [seconds] [display-id|w<window-id>]` — 10 s on the main display by default.
//! `probe-sck bench [n] [window|hidden|window-id]` — times `n` of the follower's looks at the main display,
//! or at a window, with no capture running; measure replayd and WindowServer around it.
//! `probe-sck compare` — the follower's reading of every display and window next to what
//! ScreenCaptureKit lists for it, so the two can be checked against each other.

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use std::time::Duration;

    use livekit::webrtc::video_source::native::NativeVideoSource;
    use livekit::webrtc::video_source::VideoResolution;
    use mqvi_game_capture::mac_capture::{MacCapture, Source, Target};

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    match std::env::args().nth(1).as_deref() {
        Some("bench") => return bench(std::env::args().skip(2).collect()),
        Some("compare") => return compare(),
        _ => {}
    }
    let mut args = std::env::args().skip(1);
    let seconds: u64 = args.next().map(|s| s.parse()).transpose()?.unwrap_or(10);
    let target = match args.next() {
        Some(id) => match id.strip_prefix('w') {
            Some(window) => Target::Window(window.parse()?),
            None => Target::Display(id.parse()?),
        },
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

/// The follower's cost: `n` looks in a row, as it takes one every 500 ms during a share.
#[cfg(target_os = "macos")]
fn bench(args: Vec<String>) -> anyhow::Result<()> {
    use std::time::Instant;

    use mqvi_game_capture::mac_capture::{probe_follow_once, Target};
    use screencapturekit::prelude::SCShareableContent;

    let n: u32 = args.first().map(|s| s.parse()).transpose()?.unwrap_or(200);
    // The window-server connection the helper makes in Source::find before its follower runs.
    let _ = apple_cf::cg::Display::main();
    let content = SCShareableContent::get().map_err(|e| anyhow::anyhow!("listing: {e}"))?;
    // "window": the first on-screen window with a title, so no id has to be looked up by hand.
    let target = match args.get(1).map(String::as_str) {
        Some("window") => content
            .windows()
            .iter()
            .find(|w| w.is_on_screen() && w.title().is_some_and(|t| !t.is_empty()))
            .map(|w| Target::Window(w.window_id()))
            .ok_or_else(|| anyhow::anyhow!("no titled on-screen window"))?,
        // "hidden": an off-screen one, which the follower finds only in the full window list.
        Some("hidden") => content
            .windows()
            .iter()
            .find(|w| !w.is_on_screen())
            .map(|w| Target::Window(w.window_id()))
            .ok_or_else(|| anyhow::anyhow!("no off-screen window"))?,
        Some(id) => Target::Window(id.parse()?),
        None => Target::MainDisplay,
    };
    println!("windows listed: {}, displays: {}", content.windows().len(), content.displays().len());

    probe_follow_once(target)?; // warm-up, not counted
    let mut each = Vec::with_capacity(n as usize);
    let started = Instant::now();
    for _ in 0..n {
        let t = Instant::now();
        probe_follow_once(target)?;
        each.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let total = started.elapsed().as_secs_f64();
    each.sort_by(|a, b| a.total_cmp(b));
    let pct = |p: f64| each[((each.len() - 1) as f64 * p) as usize];
    println!(
        "{target:?}: {n} looks in {total:.2}s; per look median {:.1} ms, p95 {:.1} ms, max {:.1} ms",
        pct(0.5),
        pct(0.95),
        each[each.len() - 1]
    );
    Ok(())
}

/// Every source ScreenCaptureKit lists, read both ways: its listing (on screen, content info) and
/// the follower's. Prints the ones that disagree, then a count.
#[cfg(target_os = "macos")]
fn compare() -> anyhow::Result<()> {
    use mqvi_game_capture::mac_capture::{probe_follow_once, Target};
    use screencapturekit::prelude::{SCContentFilter, SCShareableContent};
    use screencapturekit::shareable_content::SCShareableContentInfo;

    let _ = apple_cf::cg::Display::main();
    let content = SCShareableContent::get().map_err(|e| anyhow::anyhow!("listing: {e}"))?;
    let listed = |filter: anyhow::Result<SCContentFilter>| -> String {
        match filter.ok().and_then(|f| SCShareableContentInfo::for_filter(&f)) {
            Some(info) => format!("Size({:?})", info.pixel_size()),
            None => "no content info".into(),
        }
    };
    let (mut same, mut differ) = (0, 0);
    let mut check = |what: String, sck: String, ours: String| {
        if sck == ours {
            same += 1;
        } else {
            differ += 1;
            println!("{what}: ScreenCaptureKit {sck}, follower {ours}");
        }
    };
    for d in content.displays() {
        let filter = SCContentFilter::create().with_display(&d).build().map_err(|e| anyhow::anyhow!("{e}"));
        let ours = probe_follow_once(Target::Display(d.display_id())).unwrap_or_else(|e| format!("error {e:#}"));
        check(format!("display {}", d.display_id()), listed(filter), ours);
    }
    let ours_main = probe_follow_once(Target::MainDisplay)?;
    println!("main display: follower {ours_main}");
    for w in content.windows() {
        let sck = if w.is_on_screen() {
            listed(SCContentFilter::create().with_window(&w).build().map_err(|e| anyhow::anyhow!("{e}")))
        } else {
            "Hidden".into()
        };
        let ours = probe_follow_once(Target::Window(w.window_id())).unwrap_or_else(|e| format!("error {e:#}"));
        let title = w.title().unwrap_or_default();
        check(format!("window {} {:?} ({:.0}x{:.0} pt)", w.window_id(), title, w.frame().size.width, w.frame().size.height), sck, ours);
    }
    let gone = probe_follow_once(Target::Window(u32::MAX - 1))?;
    println!("a window id that does not exist: follower {gone}");
    println!("{same} agree, {differ} differ, of {} displays and {} windows", content.displays().len(), content.windows().len());
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
