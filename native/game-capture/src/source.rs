//! What every platform's capture shares: how a source that went away is reported.

/// The source a capture was following no longer exists: the window closed, the game exited, the
/// display was unplugged. Typed rather than a message so the process can end with its own exit code —
/// to the app this is the user's doing, not a failure, exactly like a browser share whose source
/// closes.
#[derive(Debug)]
pub struct SourceGone;

impl std::fmt::Display for SourceGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the captured window or display is gone")
    }
}

impl std::error::Error for SourceGone {}
