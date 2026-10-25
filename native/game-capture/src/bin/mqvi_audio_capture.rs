//! macOS: a share's audio on stdout, in audio-capture.exe's format, until the app closes stdin.
//!
//! Its own binary, not a mode of mqvi-game-capture: replayd drops both connections when two
//! processes of one signed identity reach it at once, and a share starts video and audio together.
//! Measured 2026-10-25: started side by side from the one binary, 3 of 3 runs hung inside
//! ScreenCaptureKit; with a second binary beside it, none did.

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use clap::Parser;
    use mqvi_game_capture::mac_audio::{self, AudioTarget};

    /// With --window-id the window's application is captured; with --display-id or no target,
    /// everything but mqvi.
    #[derive(Parser)]
    #[command(name = "mqvi-audio-capture", version, about)]
    struct Args {
        /// The CGWindowID in a desktopCapturer "window:<id>:<n>" source id.
        #[arg(long, conflicts_with = "display_id")]
        window_id: Option<u32>,
        /// The CGDirectDisplayID in a desktopCapturer "screen:<id>:<n>" source id.
        #[arg(long)]
        display_id: Option<u32>,
        /// The app's main process, whose applications (its Electron helpers included) are left out.
        #[arg(long)]
        self_pid: Option<i32>,
    }

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = Args::parse();
    let target = match (args.window_id, args.display_id) {
        (Some(id), _) => AudioTarget::Window(id),
        (None, Some(id)) => AudioTarget::Display(id),
        (None, None) => AudioTarget::AllButOurs,
    };
    mac_audio::run(target, args.self_pid)
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("mqvi-audio-capture is macOS-only; Windows uses audio-capture.exe");
    std::process::exit(2);
}
