//! What libwebrtc does with the frames the hardware pump hands it.
//!
//! Those frames are already encoded, and each is the reference for the next. libwebrtc can still
//! drop one before the pass-through sees it (a paused encoder, a repeated capture time); the
//! patched pass-through then holds every delta until a keyframe. "Dropped after our encoder" counts
//! both: frames libwebrtc dropped and frames held for recovery. Viewers see a short freeze, not
//! corruption, and no viewer can ask about it — only these counters show it.

use std::time::Duration;

use livekit::track::LocalVideoTrack;
use livekit::webrtc::stats::{QualityLimitationReason, RtcStats};

/// libwebrtc's own counters for the published track, from one stats snapshot.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DeliveryCounts {
    /// Frames libwebrtc took from our source (media-source `frames`).
    pub taken: u64,
    /// Frames that came out of the pass-through encoder (outbound-rtp `framesEncoded`).
    pub encoded: u64,
    pub key_frames: u64,
    /// Keyframe requests (PLI) viewers sent through the SFU.
    pub keyframe_asks: u64,
    pub limited_by: QualityLimitationReason,
}

impl DeliveryCounts {
    pub fn from_stats(stats: &[RtcStats]) -> Self {
        let mut counts = Self::default();
        for s in stats {
            match s {
                RtcStats::MediaSource(m) if m.source.kind == "video" => {
                    counts.taken += u64::from(m.video.frames);
                }
                RtcStats::OutboundRtp(o) if o.stream.kind == "video" => {
                    counts.encoded += u64::from(o.outbound.frames_encoded);
                    counts.key_frames += u64::from(o.outbound.key_frames_encoded);
                    counts.keyframe_asks += u64::from(o.outbound.pli_count);
                    counts.limited_by = o.outbound.quality_limitation_reason;
                }
                _ => {}
            }
        }
        counts
    }

    /// Frames taken but never encoded since the sender started. One may still be in flight.
    pub fn dropped(&self) -> u64 {
        self.taken.saturating_sub(self.encoded)
    }
}

/// The log line for the second between two snapshots. Saturating: the counters restart when the
/// sender is rebuilt on a reconnect.
fn describe(last: &DeliveryCounts, now: &DeliveryCounts) -> String {
    format!(
        "webrtc: took {} frames, encoded {}, {} dropped after our encoder ({} since start) | {} keyframes, {} keyframe asks, limited by {:?}",
        now.taken.saturating_sub(last.taken),
        now.encoded.saturating_sub(last.encoded),
        now.dropped().saturating_sub(last.dropped()),
        now.dropped(),
        now.key_frames.saturating_sub(last.key_frames),
        now.keyframe_asks.saturating_sub(last.keyframe_asks),
        now.limited_by,
    )
}

/// Logs one line a second until the task is aborted.
pub async fn watch(track: LocalVideoTrack) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut last = DeliveryCounts::default();
    loop {
        tick.tick().await;
        // The sender is briefly absent during a reconnect; a missed reading is not worth a line.
        let Ok(stats) = track.get_stats().await else { continue };
        let now = DeliveryCounts::from_stats(&stats);
        log::info!("{}", describe(&last, &now));
        last = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use livekit::webrtc::stats::dictionaries;
    use livekit::webrtc::stats::{MediaSourceStats, OutboundRtpStats};

    fn source(kind: &str, frames: u32) -> RtcStats {
        RtcStats::MediaSource(MediaSourceStats {
            source: dictionaries::MediaSourceStats { kind: kind.into(), ..Default::default() },
            video: dictionaries::VideoSourceStats { frames, ..Default::default() },
            ..Default::default()
        })
    }

    fn outbound(kind: &str, encoded: u32, key_frames: u32, plis: u32) -> RtcStats {
        RtcStats::OutboundRtp(OutboundRtpStats {
            stream: dictionaries::RtpStreamStats { kind: kind.into(), ..Default::default() },
            outbound: dictionaries::OutboundRtpStreamStats {
                frames_encoded: encoded,
                key_frames_encoded: key_frames,
                pli_count: plis,
                quality_limitation_reason: QualityLimitationReason::Bandwidth,
                ..Default::default()
            },
            ..Default::default()
        })
    }

    #[test]
    fn should_read_only_the_video_counters_when_audio_stats_are_mixed_in() {
        let stats = [
            source("video", 120),
            outbound("video", 117, 4, 2),
            source("audio", 0),
            outbound("audio", 0, 0, 0),
        ];

        let counts = DeliveryCounts::from_stats(&stats);

        assert_eq!(
            counts,
            DeliveryCounts {
                taken: 120,
                encoded: 117,
                key_frames: 4,
                keyframe_asks: 2,
                limited_by: QualityLimitationReason::Bandwidth,
            }
        );
    }

    #[test]
    fn should_count_frames_taken_but_never_encoded_as_dropped() {
        let counts = DeliveryCounts { taken: 120, encoded: 117, ..Default::default() };

        assert_eq!(counts.dropped(), 3);
    }

    #[test]
    fn should_report_only_the_new_drops_when_describing_a_second() {
        let last = DeliveryCounts { taken: 90, encoded: 89, ..Default::default() };
        let now = DeliveryCounts { taken: 120, encoded: 114, ..Default::default() };

        let line = describe(&last, &now);

        let expected = "took 30 frames, encoded 25, 5 dropped after our encoder (6 since start)";
        assert!(line.contains(expected), "{line}");
    }

    #[test]
    fn should_not_underflow_when_the_sender_restarts_its_counters() {
        let last = DeliveryCounts {
            taken: 900,
            encoded: 880,
            key_frames: 9,
            keyframe_asks: 4,
            ..Default::default()
        };
        let now = DeliveryCounts { taken: 30, encoded: 30, ..Default::default() };

        let line = describe(&last, &now);

        let expected = "took 0 frames, encoded 0, 0 dropped after our encoder (0 since start) | 0 keyframes, 0 keyframe asks";
        assert!(line.contains(expected), "{line}");
    }
}
