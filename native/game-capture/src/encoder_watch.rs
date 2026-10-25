//! macOS: which encoder libwebrtc actually runs, and what it makes of the frames.
//!
//! The mac hands libwebrtc raw frames and asks for VideoToolbox, but asking is not getting:
//! libwebrtc can fall back to a software encoder without saying so. Only the sender's own stats
//! (`encoderImplementation`, `powerEfficientEncoder`) show which one is running.

use std::time::{Duration, Instant};

use livekit::track::LocalVideoTrack;
use livekit::webrtc::stats::{DtlsTransportState, QualityLimitationReason, RtcStats};

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
    pub key_frames: u32,
    /// Keyframes viewers asked for (PLI + FIR): a viewer that cannot decode asks, so a picture
    /// frozen at the viewer while frames still go out shows here.
    pub keyframe_asks: u32,
    pub nacks: u32,
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
                key_frames: o.outbound.key_frames_encoded,
                keyframe_asks: o.outbound.pli_count.saturating_add(o.outbound.fir_count),
                nacks: o.outbound.nack_count,
            }),
            _ => None,
        })
    }
}

/// What the startup check makes of one stats reading (see `confirm_hardware_encode` in share_mac).
#[derive(Debug, PartialEq)]
pub enum EncodeCheck {
    /// A frame was encoded in hardware: ready, with the encoder's name.
    Hardware(String),
    /// A frame was encoded, but by a software encoder.
    Software(String),
    /// Connected for longer than the budget, and still nothing encoded.
    TimedOut,
    /// Keep waiting. Some once the transport has connected, from then on.
    Waiting(Option<Instant>),
}

/// One step of the startup check. The budget runs from the transport connecting, not from publish:
/// libwebrtc encodes nothing before the connection, which alone can take seconds.
pub fn check_encode(stats: &[RtcStats], connected_at: Option<Instant>, now: Instant, budget: Duration) -> EncodeCheck {
    if let Some(r) = EncoderReading::from_stats(stats).filter(|r| r.frames_encoded > 0) {
        let name = if r.implementation.is_empty() { "an unnamed encoder".to_string() } else { r.implementation };
        return if r.hardware { EncodeCheck::Hardware(name) } else { EncodeCheck::Software(name) };
    }
    let connected_at = connected_at.or_else(|| transport_connected(stats).then_some(now));
    match connected_at {
        Some(since) if now.duration_since(since) >= budget => EncodeCheck::TimedOut,
        waiting => EncodeCheck::Waiting(waiting),
    }
}

fn transport_connected(stats: &[RtcStats]) -> bool {
    stats
        .iter()
        .any(|s| matches!(s, RtcStats::Transport(t) if t.transport.dtls_state == Some(DtlsTransportState::Connected)))
}

/// The log line for the interval between two readings. Saturating: the counters restart when the
/// sender is rebuilt on a reconnect.
pub fn describe(last: &EncoderReading, now: &EncoderReading, secs: f64) -> String {
    let frames = now.frames_encoded.saturating_sub(last.frames_encoded);
    let sent_kbps = now.bytes_sent.saturating_sub(last.bytes_sent) as f64 * 8.0 / 1000.0 / secs.max(0.001);
    let qp = if frames == 0 { 0.0 } else { now.qp_sum.saturating_sub(last.qp_sum) as f64 / frames as f64 };
    format!(
        "encoder: {} (hardware {}) {}x{} {:.1} fps, sent {:.0} kbps of {:.0} target, qp {:.1}, limited by {:?}, keyframes {} (asked {}), nacks {}",
        if now.implementation.is_empty() { "?" } else { &now.implementation },
        now.hardware,
        now.size.0,
        now.size.1,
        now.fps,
        sent_kbps,
        now.target_bps / 1000.0,
        qp,
        now.limited_by,
        now.key_frames.saturating_sub(last.key_frames),
        now.keyframe_asks.saturating_sub(last.keyframe_asks),
        now.nacks.saturating_sub(last.nacks),
    )
}

/// Logs one line every two seconds until the task is aborted.
pub async fn watch(track: LocalVideoTrack) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    // The first reading is only a baseline: its counters run from the start of the stream, not
    // from one interval ago, and dividing them by two seconds printed nonsense rates.
    let mut last: Option<(EncoderReading, Instant)> = None;
    loop {
        tick.tick().await;
        // The sender is briefly absent during a reconnect; a missed reading is not worth a line.
        let Ok(stats) = track.get_stats().await else { continue };
        let Some(now) = EncoderReading::from_stats(&stats) else { continue };
        if let Some((prev, at)) = &last {
            log::info!("{}", describe(prev, &now, at.elapsed().as_secs_f64()));
        }
        last = Some((now, Instant::now()));
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

    fn transport(dtls: DtlsTransportState) -> RtcStats {
        use livekit::webrtc::stats::TransportStats;
        RtcStats::Transport(TransportStats {
            transport: dictionaries::TransportStats { dtls_state: Some(dtls), ..Default::default() },
            ..Default::default()
        })
    }

    const BUDGET: Duration = Duration::from_secs(5);

    #[test]
    fn should_be_ready_on_a_frame_encoded_in_hardware() {
        let stats = [outbound("video", "VideoToolbox", 10, 1, 1)];
        assert_eq!(check_encode(&stats, None, Instant::now(), BUDGET), EncodeCheck::Hardware("VideoToolbox".into()));
    }

    #[test]
    fn should_refuse_a_frame_encoded_in_software() {
        let mut stats = outbound("video", "OpenH264", 10, 1, 1);
        if let RtcStats::OutboundRtp(o) = &mut stats {
            o.outbound.power_efficient_encoder = false;
        }
        assert_eq!(check_encode(&[stats], None, Instant::now(), BUDGET), EncodeCheck::Software("OpenH264".into()));
    }

    #[test]
    fn should_not_start_the_clock_before_the_transport_connects() {
        // A slow network: long after publish, still connecting. No verdict; the app's own ready
        // timeout bounds this case.
        let t0 = Instant::now();
        let stats = [outbound("video", "", 0, 0, 0), transport(DtlsTransportState::Connecting)];
        assert_eq!(check_encode(&stats, None, t0 + Duration::from_secs(30), BUDGET), EncodeCheck::Waiting(None));
    }

    #[test]
    fn should_start_the_clock_when_the_transport_connects() {
        let t0 = Instant::now();
        let stats = [outbound("video", "", 0, 0, 0), transport(DtlsTransportState::Connected)];
        assert_eq!(check_encode(&stats, None, t0, BUDGET), EncodeCheck::Waiting(Some(t0)));
    }

    #[test]
    fn should_time_out_only_once_connected_for_the_whole_budget() {
        let t0 = Instant::now();
        let stats = [outbound("video", "", 0, 0, 0), transport(DtlsTransportState::Connected)];
        assert_eq!(check_encode(&stats, Some(t0), t0 + BUDGET - Duration::from_millis(1), BUDGET), EncodeCheck::Waiting(Some(t0)));
        assert_eq!(check_encode(&stats, Some(t0), t0 + BUDGET, BUDGET), EncodeCheck::TimedOut);
    }

    #[test]
    fn should_count_keyframes_and_viewer_requests_over_the_interval() {
        let mut last = EncoderReading { key_frames: 1, keyframe_asks: 2, nacks: 10, ..Default::default() };
        let now = EncoderReading { key_frames: 4, keyframe_asks: 5, nacks: 15, ..Default::default() };
        assert!(describe(&last, &now, 2.0).contains("keyframes 3 (asked 3), nacks 5"));
        // A rebuilt sender restarts its counters: no wrap-around.
        last.key_frames = 9;
        assert!(describe(&last, &now, 2.0).contains("keyframes 0"));
    }

    #[test]
    fn should_not_divide_by_zero_when_nothing_was_encoded() {
        let r = EncoderReading::default();
        assert!(describe(&r, &r, 0.0).contains("qp 0.0"));
    }
}
