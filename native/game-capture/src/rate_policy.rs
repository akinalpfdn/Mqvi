//! When the hardware encoder's bitrate follows libwebrtc's target.
//!
//! A falling target is followed at once: every frame the encoder makes above the target is one
//! libwebrtc may drop after the frames behind it already reference it. A rising target must hold
//! first — an estimate that wobbles upward would otherwise reconfigure the MFT many times a second,
//! which makes it emit undecodable frames.

use std::time::{Duration, Instant};

/// A target below this share of the applied bitrate is followed at once.
const FOLLOW_DOWN_BELOW: f64 = 0.9;
/// A target at or above this share of the applied bitrate is followed once it has held.
const FOLLOW_UP_FROM: f64 = 1.1;
/// The MFT is never reconfigured more often than this.
const MIN_CHANGE_GAP: Duration = Duration::from_millis(200);
/// How long a higher target must hold, and how often a rise may apply.
const RISE_HOLD: Duration = Duration::from_secs(1);
/// The most we ever ask of the encoder.
const MAX_BPS: u32 = 20_000_000;

pub struct RatePolicy {
    applied: u32,
    last_change: Option<Instant>,
    /// When the target first stood high enough to rise; cleared whenever it falls back.
    higher_since: Option<Instant>,
}

impl RatePolicy {
    pub fn new(start_bps: u32) -> Self {
        Self { applied: start_bps, last_change: None, higher_since: None }
    }

    /// The bitrate the encoder is running at, as far as we know.
    pub fn applied(&self) -> u32 {
        self.applied
    }

    /// The bitrate to apply now for libwebrtc's latest `target`, if it should change. A target of 0
    /// (no estimate yet, or a paused encoder) changes nothing.
    pub fn next(&mut self, target: u32, now: Instant) -> Option<u32> {
        if target == 0 {
            return None;
        }
        let target = target.min(MAX_BPS);
        let since_change = self.last_change.map(|t| now.duration_since(t));

        if f64::from(target) < f64::from(self.applied) * FOLLOW_DOWN_BELOW {
            self.higher_since = None;
            if since_change.is_some_and(|d| d < MIN_CHANGE_GAP) {
                return None;
            }
            return Some(self.change_to(target, now));
        }

        if f64::from(target) >= f64::from(self.applied) * FOLLOW_UP_FROM {
            let since = *self.higher_since.get_or_insert(now);
            let held = now.duration_since(since) >= RISE_HOLD;
            let spaced = since_change.is_none_or(|d| d >= RISE_HOLD);
            if held && spaced {
                self.higher_since = None;
                return Some(self.change_to(target, now));
            }
            return None;
        }

        self.higher_since = None;
        None
    }

    /// The MFT refused the last value and still runs at `kept`. The refusal counts as a change, so
    /// the next attempt waits `MIN_CHANGE_GAP` like any other.
    pub fn refused(&mut self, kept: u32) {
        self.applied = kept;
    }

    fn change_to(&mut self, bps: u32, now: Instant) -> u32 {
        self.applied = bps;
        self.last_change = Some(now);
        bps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn should_follow_a_falling_target_at_once() {
        let t0 = Instant::now();
        let mut rate = RatePolicy::new(6_000_000);

        assert_eq!(rate.next(4_000_000, t0), Some(4_000_000));
        assert_eq!(rate.applied(), 4_000_000);
    }

    #[test]
    fn should_hold_a_rising_target_until_it_has_stood_for_a_second() {
        let t0 = Instant::now();
        let mut rate = RatePolicy::new(2_000_000);

        assert_eq!(rate.next(3_000_000, t0), None);
        assert_eq!(rate.next(3_000_000, t0 + ms(999)), None);
        assert_eq!(rate.next(3_000_000, t0 + ms(1000)), Some(3_000_000));
    }

    #[test]
    fn should_restart_the_wait_when_a_rising_target_falls_back() {
        let t0 = Instant::now();
        let mut rate = RatePolicy::new(2_000_000);

        rate.next(3_000_000, t0);
        rate.next(2_000_000, t0 + ms(500));

        assert_eq!(rate.next(3_000_000, t0 + ms(1200)), None);
        assert_eq!(rate.next(3_000_000, t0 + ms(2200)), Some(3_000_000));
    }

    #[test]
    fn should_ignore_moves_within_ten_percent_when_the_target_barely_changes() {
        let t0 = Instant::now();
        let mut rate = RatePolicy::new(5_000_000);

        assert_eq!(rate.next(4_600_000, t0), None);
        assert_eq!(rate.next(5_400_000, t0 + ms(2000)), None);
        assert_eq!(rate.applied(), 5_000_000);
    }

    #[test]
    fn should_not_reconfigure_within_200ms_when_the_target_keeps_falling() {
        let t0 = Instant::now();
        let mut rate = RatePolicy::new(6_000_000);

        assert_eq!(rate.next(5_000_000, t0), Some(5_000_000));
        assert_eq!(rate.next(4_000_000, t0 + ms(150)), None);
        assert_eq!(rate.next(4_000_000, t0 + ms(200)), Some(4_000_000));
    }

    #[test]
    fn should_bound_the_changes_when_the_target_flaps() {
        let t0 = Instant::now();
        let mut rate = RatePolicy::new(4_000_000);
        let mut changes = 0;

        // Ten seconds of a target swinging 2 <-> 6 Mbps every 33 ms frame.
        for frame in 0..300u64 {
            let target = if frame % 2 == 0 { 2_000_000 } else { 6_000_000 };
            if rate.next(target, t0 + ms(frame * 33)).is_some() {
                changes += 1;
            }
        }

        // A rise needs a full second of the higher target, which a flap never gives it.
        assert!(changes <= 1, "{changes} changes");
    }

    #[test]
    fn should_keep_the_previous_bitrate_when_the_mft_refuses() {
        let t0 = Instant::now();
        let mut rate = RatePolicy::new(6_000_000);

        rate.next(3_000_000, t0);
        rate.refused(6_000_000);

        assert_eq!(rate.applied(), 6_000_000);
        assert_eq!(rate.next(3_000_000, t0 + ms(100)), None);
        assert_eq!(rate.next(3_000_000, t0 + ms(200)), Some(3_000_000));
    }

    #[test]
    fn should_change_nothing_when_there_is_no_target_yet() {
        let mut rate = RatePolicy::new(2_000_000);

        assert_eq!(rate.next(0, Instant::now()), None);
        assert_eq!(rate.applied(), 2_000_000);
    }

    #[test]
    fn should_follow_the_target_below_the_old_800k_floor() {
        let mut rate = RatePolicy::new(2_000_000);

        assert_eq!(rate.next(300_000, Instant::now()), Some(300_000));
    }

    #[test]
    fn should_cap_what_it_asks_of_the_encoder() {
        let t0 = Instant::now();
        let mut rate = RatePolicy::new(10_000_000);

        rate.next(50_000_000, t0);

        assert_eq!(rate.next(50_000_000, t0 + ms(1000)), Some(MAX_BPS));
    }
}
