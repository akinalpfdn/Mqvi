//! macOS: which encoder libwebrtc actually runs, and what it makes of the frames.
//!
//! The mac hands libwebrtc raw frames and asks for VideoToolbox, but asking is not getting:
//! libwebrtc can fall back to a software encoder without saying so. Only the sender's own stats
//! (`encoderImplementation`, `powerEfficientEncoder`) show which one is running.

use std::time::{Duration, Instant};

use livekit::track::LocalVideoTrack;
use livekit::webrtc::stats::{QualityLimitationReason, RtcStats};

/// One reading of the published video sender.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EncoderReading {
    pub implementation: String,
    pub hardware: bool,
    pub size: (u32, u32),
    pub fps: f64,
    pub target_bps: f64,
    pub bytes_sent: u64,
    pub frames_encoded: u32,
    pub qp_sum: u64,
    pub limited_by: QualityLimitationReason,
}

impl EncoderReading {
    pub fn from_stats(stats: &[RtcStats]) -> Option<Self> {
        stats.iter().find_map(|s| match s {
            RtcStats::OutboundRtp(o) if o.stream.kind == "video" => Some(Self {
                implementation: o.outbound.encoder_implementation.clone(),
                hardware: o.outbound.power_efficient_encoder,
                size: (o.outbound.frame_width, o.outbound.frame_height),
                fps: o.outbound.frames_per_second,
                target_bps: o.outbound.target_bitrate,
                bytes_sent: o.sent.bytes_sent,
                frames_encoded: o.outbound.frames_encoded,
                qp_sum: o.outbound.qp_sum,
                limited_by: o.outbound.quality_limitation_reason,
            }),
            _ => None,
        })
    }
}

/// The log line for the interval between two readings. Saturating: the counters restart when the
/// sender is rebuilt on a reconnect.
pub fn describe(last: &EncoderReading, now: &EncoderReading, secs: f64) -> String {
    let frames = now.frames_encoded.saturating_sub(last.frames_encoded);
    let sent_kbps = now.bytes_sent.saturating_sub(last.bytes_sent) as f64 * 8.0 / 1000.0 / secs.max(0.001);
    let qp = if frames == 0 { 0.0 } else { now.qp_sum.saturating_sub(last.qp_sum) as f64 / frames as f64 };
    format!(
        "encoder: {} (hardware {}) {}x{} {:.1} fps, sent {:.0} kbps of {:.0} target, qp {:.1}, limited by {:?}",
        if now.implementation.is_empty() { "?" } else { &now.implementation },
        now.hardware,
        now.size.0,
        now.size.1,
        now.fps,
        sent_kbps,
        now.target_bps / 1000.0,
        qp,
        now.limited_by,
    )
}

/// Logs one line every two seconds until the task is aborted.
pub async fn watch(track: LocalVideoTrack) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut last = EncoderReading::default();
    let mut at = Instant::now();
    loop {
        tick.tick().await;
        // The sender is briefly absent during a reconnect; a missed reading is not worth a line.
        let Ok(stats) = track.get_stats().await else { continue };
        let Some(now) = EncoderReading::from_stats(&stats) else { continue };
        log::info!("{}", describe(&last, &now, at.elapsed().as_secs_f64()));
        last = now;
        at = Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use livekit::webrtc::stats::dictionaries;
    use livekit::webrtc::stats::OutboundRtpStats;

    fn outbound(kind: &str, implementation: &str, bytes_sent: u64, frames: u32, qp_sum: u64) -> RtcStats {
        RtcStats::OutboundRtp(OutboundRtpStats {
            stream: dictionaries::RtpStreamStats { kind: kind.into(), ..Default::default() },
            sent: dictionaries::SentRtpStreamStats { bytes_sent, ..Default::default() },
            outbound: dictionaries::OutboundRtpStreamStats {
                encoder_implementation: implementation.into(),
                power_efficient_encoder: true,
                frames_encoded: frames,
                qp_sum,
                ..Default::default()
            },
            ..Default::default()
        })
    }

    #[test]
    fn should_read_the_video_sender_and_skip_audio() {
        let stats = [outbound("audio", "opus", 1, 1, 1), outbound("video", "VideoToolbox", 10, 2, 3)];
        let r = EncoderReading::from_stats(&stats).expect("a video sender");
        assert_eq!((r.implementation.as_str(), r.hardware, r.bytes_sent), ("VideoToolbox", true, 10));
    }

    #[test]
    fn should_report_rate_and_mean_qp_over_the_interval() {
        let last = EncoderReading::from_stats(&[outbound("video", "VideoToolbox", 0, 0, 0)]).unwrap();
        // 250 000 bytes in 2 s = 1000 kbps; 60 frames with a qp sum of 1500 = qp 25.
        let now = EncoderReading::from_stats(&[outbound("video", "VideoToolbox", 250_000, 60, 1500)]).unwrap();
        let line = describe(&last, &now, 2.0);
        assert!(line.contains("sent 1000 kbps"), "{line}");
        assert!(line.contains("qp 25.0"), "{line}");
    }

    #[test]
    fn should_not_divide_by_zero_when_nothing_was_encoded() {
        let r = EncoderReading::default();
        assert!(describe(&r, &r, 0.0).contains("qp 0.0"));
    }
}
