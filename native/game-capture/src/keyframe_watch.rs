//! Notices a hardware encoder that does not answer a keyframe request.
//!
//! A viewer, or the pass-through after a dropped frame, waits on that keyframe. An MFT that misses
//! the request (or has no keyframe control at all) would leave it waiting until the next periodic
//! IDR, or for good once the GOP is lengthened. A rebuilt encoder starts with an IDR.

/// Frames out of the encoder a requested keyframe may take before the encoder is rebuilt.
const PATIENCE: u32 = 10;

#[derive(Default)]
pub struct KeyframeWatch {
    /// Frames out since the open request; None while nothing is asked.
    waiting: Option<u32>,
}

impl KeyframeWatch {
    /// A keyframe was asked of the encoder. A request already open keeps its count.
    pub fn requested(&mut self) {
        self.waiting.get_or_insert(0);
    }

    /// One frame came out of the encoder. True when it has now ignored the request for `PATIENCE`
    /// frames and should be rebuilt; the watch is cleared then.
    pub fn delivered(&mut self, keyframe: bool) -> bool {
        let Some(frames) = self.waiting else { return false };
        if keyframe {
            self.waiting = None;
            return false;
        }
        if frames + 1 >= PATIENCE {
            self.waiting = None;
            return true;
        }
        self.waiting = Some(frames + 1);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_stay_quiet_when_nothing_was_asked() {
        let mut watch = KeyframeWatch::default();

        assert!((0..50).all(|_| !watch.delivered(false)));
    }

    #[test]
    fn should_clear_when_the_keyframe_arrives() {
        let mut watch = KeyframeWatch::default();
        watch.requested();

        for _ in 0..5 {
            watch.delivered(false);
        }
        watch.delivered(true);

        assert!((0..50).all(|_| !watch.delivered(false)));
    }

    #[test]
    fn should_ask_for_a_rebuild_when_ten_deltas_pass_unanswered() {
        let mut watch = KeyframeWatch::default();
        watch.requested();

        let rebuilds: Vec<bool> = (0..10).map(|_| watch.delivered(false)).collect();

        assert_eq!(rebuilds.iter().filter(|r| **r).count(), 1);
        assert!(rebuilds[9]);
    }

    #[test]
    fn should_keep_counting_when_asked_again_while_waiting() {
        let mut watch = KeyframeWatch::default();
        watch.requested();
        for _ in 0..6 {
            watch.delivered(false);
        }

        watch.requested();

        assert!((0..3).all(|_| !watch.delivered(false)));
        assert!(watch.delivered(false));
    }
}
