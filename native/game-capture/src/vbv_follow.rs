//! When the hardware encoder is rebuilt so its VBV fits the bitrate again.
//!
//! An MFT fixes its VBV when it is created, and the VBV caps how large one frame may be. Sized for one
//! bitrate and run at a much lower one, a keyframe can carry seconds of data in one burst — enough to
//! collapse libwebrtc's link estimate (measured 2026-10-23). A rebuild costs a keyframe, so it happens
//! only for a large change that has held.

use std::time::{Duration, Instant};

/// How far the bitrate may stray from the one the VBV was sized for, either way, before a rebuild.
const FACTOR: f64 = 2.0;
/// How long it must stay that far.
const HOLD: Duration = Duration::from_secs(2);
/// The least time between two encoders, whatever built them.
const MIN_GAP: Duration = Duration::from_secs(5);

pub struct VbvFollow {
    /// The bitrate the current encoder's VBV was sized from.
    basis: u32,
    /// When the applied bitrate left the band around `basis`; None while inside it.
    outside_since: Option<Instant>,
    built_at: Instant,
}

impl VbvFollow {
    pub fn new(basis: u32, now: Instant) -> Self {
        Self { basis, outside_since: None, built_at: now }
    }

    pub fn basis(&self) -> u32 {
        self.basis
    }

    /// An encoder was built with a VBV sized from `basis` — by this rule or any other rebuild.
    pub fn rebuilt(&mut self, basis: u32, now: Instant) {
        *self = Self::new(basis, now);
    }

    /// Whether the encoder should be rebuilt for the `applied` bitrate. Stays true until `rebuilt`.
    pub fn should_rebuild(&mut self, applied: u32, now: Instant) -> bool {
        let ratio = f64::from(applied) / f64::from(self.basis.max(1));
        if ratio > 1.0 / FACTOR && ratio < FACTOR {
            self.outside_since = None;
            return false;
        }
        let since = *self.outside_since.get_or_insert(now);
        now.duration_since(since) >= HOLD && now.duration_since(self.built_at) >= MIN_GAP
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn should_keep_the_encoder_when_the_bitrate_stays_within_twice_its_basis() {
        let t0 = Instant::now();
        let mut follow = VbvFollow::new(4_000_000, t0);

        assert!(!follow.should_rebuild(2_100_000, t0 + s(10)));
        assert!(!follow.should_rebuild(7_900_000, t0 + s(20)));
    }

    #[test]
    fn should_rebuild_when_the_bitrate_has_held_far_below_its_basis_for_two_seconds() {
        let t0 = Instant::now();
        let mut follow = VbvFollow::new(6_000_000, t0);

        assert!(!follow.should_rebuild(800_000, t0 + s(10)));
        assert!(!follow.should_rebuild(800_000, t0 + Duration::from_millis(11_900)));
        assert!(follow.should_rebuild(800_000, t0 + s(12)));
    }

    #[test]
    fn should_rebuild_when_the_bitrate_has_held_far_above_its_basis() {
        let t0 = Instant::now();
        let mut follow = VbvFollow::new(800_000, t0);

        follow.should_rebuild(3_000_000, t0 + s(6));

        assert!(follow.should_rebuild(3_000_000, t0 + s(8)));
    }

    #[test]
    fn should_restart_the_hold_when_the_bitrate_comes_back_into_the_band() {
        let t0 = Instant::now();
        let mut follow = VbvFollow::new(6_000_000, t0);

        follow.should_rebuild(800_000, t0 + s(10));
        follow.should_rebuild(5_000_000, t0 + s(11));

        assert!(!follow.should_rebuild(800_000, t0 + s(12)));
        assert!(follow.should_rebuild(800_000, t0 + s(14)));
    }

    #[test]
    fn should_wait_five_seconds_after_any_rebuild() {
        let t0 = Instant::now();
        let mut follow = VbvFollow::new(6_000_000, t0);

        follow.rebuilt(6_000_000, t0 + s(10));
        follow.should_rebuild(800_000, t0 + s(10));

        assert!(!follow.should_rebuild(800_000, t0 + s(13)));
        assert!(follow.should_rebuild(800_000, t0 + s(15)));
        assert_eq!(follow.basis(), 6_000_000);
    }
}
