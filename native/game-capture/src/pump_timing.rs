//! When the hardware pump hands frames to livekit.
//!
//! Both rules guard the same thing: a frame libwebrtc drops after our encoder breaks the reference
//! chain for every viewer, so the pump must not hand over frames libwebrtc is bound to drop.

use std::time::Duration;

/// The least time between two handoffs. libwebrtc drops a frame whose capture time lands in the
/// same millisecond as the previous one's.
const HANDOFF_SPACING: Duration = Duration::from_micros(1500);

/// The slot to encode next after `elapsed_us` of a schedule that is at slot `idx`, and how many
/// slots that skips. A pump a full frame or more behind moves to the current slot instead of
/// encoding the missed ones back to back — a burst libwebrtc would see as overshoot.
pub fn skip_missed_slots(idx: u64, elapsed_us: u64, frame_us: u64) -> (u64, u64) {
    let current = elapsed_us / frame_us;
    if current <= idx {
        return (idx, 0);
    }
    (current, current - idx)
}

/// How long to wait so this handoff lands at least `HANDOFF_SPACING` after the previous one.
pub fn handoff_wait(since_last: Option<Duration>) -> Duration {
    match since_last {
        Some(since) if since < HANDOFF_SPACING => HANDOFF_SPACING - since,
        _ => Duration::ZERO,
    }
}

/// Dev harness: whether the frame about to go out, after `handoffs` so far, is held back to go out
/// in the same millisecond as the next one — a drop libwebrtc makes on its own. 0 turns it off.
pub fn holds_for_same_ms_pair(handoffs: u64, every: u64) -> bool {
    every > 0 && (handoffs + 1).is_multiple_of(every)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME_US: u64 = 33_333;

    #[test]
    fn should_keep_the_slot_when_less_than_a_frame_late() {
        let idx = 10;
        let elapsed = idx * FRAME_US + FRAME_US / 2;

        assert_eq!(skip_missed_slots(idx, elapsed, FRAME_US), (10, 0));
    }

    #[test]
    fn should_keep_the_slot_when_ahead_of_schedule() {
        assert_eq!(skip_missed_slots(10, 9 * FRAME_US, FRAME_US), (10, 0));
    }

    #[test]
    fn should_jump_to_the_current_slot_when_frames_were_missed() {
        let elapsed = 13 * FRAME_US + FRAME_US / 2;

        assert_eq!(skip_missed_slots(10, elapsed, FRAME_US), (13, 3));
    }

    #[test]
    fn should_wait_out_the_spacing_when_the_last_handoff_was_recent() {
        let wait = handoff_wait(Some(Duration::from_micros(500)));

        assert_eq!(wait, Duration::from_micros(1000));
    }

    #[test]
    fn should_not_wait_when_the_last_handoff_was_long_enough_ago() {
        assert_eq!(handoff_wait(Some(Duration::from_millis(33))), Duration::ZERO);
        assert_eq!(handoff_wait(None), Duration::ZERO);
    }

    #[test]
    fn should_hold_every_nth_frame_when_the_dev_harness_is_on() {
        let held: Vec<u64> = (0..9).filter(|&h| holds_for_same_ms_pair(h, 3)).collect();

        assert_eq!(held, vec![2, 5, 8]);
    }

    #[test]
    fn should_never_hold_a_frame_when_the_dev_harness_is_off() {
        assert!((0..1000).all(|h| !holds_for_same_ms_pair(h, 0)));
    }
}
