//! What the hardware pump did in the last second, for its once-a-second line.

/// Counted, not logged per event: a subscriber that can't decode asks every second, and eight
/// identical lines say less than one number.
#[derive(Default)]
pub struct PumpStats {
    /// Frames we tried to encode.
    pub fed: u32,
    /// Encoded packets handed to livekit, and their bytes.
    pub sent: u32,
    pub bytes: usize,
    /// Keyframes asked of the encoder: viewers' requests, recovery, rebuilds.
    pub keyframes_asked: u32,
    /// Slots dropped after a stall — see pump_timing.
    pub skipped_slots: u64,
    /// Keyframes out of the encoder, the largest, and the delta frames to compare it to.
    keyframes_out: u32,
    largest_keyframe: usize,
    delta_bytes: usize,
    deltas: u32,
}

impl PumpStats {
    /// One packet came out of the encoder.
    pub fn encoded(&mut self, keyframe: bool, len: usize) {
        if keyframe {
            self.keyframes_out += 1;
            self.largest_keyframe = self.largest_keyframe.max(len);
        } else {
            self.delta_bytes += len;
            self.deltas += 1;
        }
    }

    /// The line for the last `secs`, at the encoder's `size` and bitrate and libwebrtc's target.
    pub fn describe(&self, secs: f64, size: (u32, u32), applied_bps: u32, estimate_bps: u32) -> String {
        // How much of a second at the current bitrate the largest keyframe took — the burst the
        // link had to absorb — and how it compares to an ordinary frame.
        let keyframe_seconds = self.largest_keyframe as f64 * 8.0 / f64::from(applied_bps.max(1));
        let keyframe_vs_delta = if self.deltas > 0 && self.delta_bytes > 0 {
            self.largest_keyframe as f64 / (self.delta_bytes as f64 / f64::from(self.deltas))
        } else {
            0.0
        };
        format!(
            "encode: fed {:.1} fps, sent {:.1} fps, {:.0} kbps out | {}x{}, encoder at {} kbps, link estimate {} kbps, {} keyframes asked, {} slots skipped | {} keyframes out, largest {} KB = {:.2} s of bitrate, {:.1}x a delta frame",
            self.fed as f64 / secs,
            self.sent as f64 / secs,
            (self.bytes as f64 * 8.0 / 1000.0) / secs,
            size.0,
            size.1,
            applied_bps / 1000,
            estimate_bps / 1000,
            self.keyframes_asked,
            self.skipped_slots,
            self.keyframes_out,
            self.largest_keyframe / 1024,
            keyframe_seconds,
            keyframe_vs_delta
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_print_the_pump_line_the_tests_are_read_from() {
        let mut stats = PumpStats { fed: 30, sent: 30, bytes: 750_000, keyframes_asked: 1, ..Default::default() };
        stats.encoded(true, 120 * 1024);
        for _ in 0..29 {
            stats.encoded(false, 20_000);
        }

        let line = stats.describe(1.0, (1920, 1080), 5_930_000, 6_220_000);

        assert_eq!(
            line,
            "encode: fed 30.0 fps, sent 30.0 fps, 6000 kbps out | 1920x1080, encoder at 5930 kbps, \
             link estimate 6220 kbps, 1 keyframes asked, 0 slots skipped | 1 keyframes out, \
             largest 120 KB = 0.17 s of bitrate, 6.1x a delta frame"
        );
    }

    #[test]
    fn should_compare_to_nothing_when_no_delta_frame_came_out() {
        let mut stats = PumpStats::default();
        stats.encoded(true, 50 * 1024);

        let line = stats.describe(1.0, (1280, 720), 805_000, 4_682_000);

        assert!(line.ends_with("largest 50 KB = 0.51 s of bitrate, 0.0x a delta frame"), "{line}");
    }
}
