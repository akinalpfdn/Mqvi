# webrtc-sys 0.3.38 — mqvi patches

This is `webrtc-sys` 0.3.38 from crates.io (LiveKit, Apache-2.0; see `LICENSE` and `NOTICE.md`),
used through `[patch.crates-io]` in `native/game-capture/Cargo.toml`. Everything else is unchanged.
Remove this copy when livekit/rust-sdks ships an equivalent.

## Why

The game-capture helper encodes on the GPU and hands finished H.264 access units to livekit's
pass-through encoder. libwebrtc's `VideoStreamEncoder` still treated that pass-through like any
encoder and dropped frames to keep the rate. A dropped encoded frame is the reference for the next
one, and the drop happens before RTP, so no receiver sees a gap: every viewer decoded the following
frames against a picture it never received, until the next keyframe. Measured on 2026-10-23: 45
frames dropped in a minute of game-menu toggling, 0 keyframe requests from viewers.

## What changed

| File | Change |
|---|---|
| `src/passthrough_video_encoder.cpp` | `has_trusted_rate_controller = true`, so the media-optimisation frame dropper stays off. A skip in the frame sequence (a drop elsewhere in `VideoStreamEncoder`) holds deltas until a keyframe and asks for one, again every 300 ms while it waits. `InitEncode`/`Release` restart the sequence and wait for a keyframe. |
| `src/peer_connection_factory.cpp` | Field trial `WebRTC-CongestionWindow` = `QueueSize:350,MinBitrate:30000,DropFrame:false`: congestion lowers the target instead of dropping frames. Applies to every encoder this factory serves. |
| `include/livekit/encoded_video_frame_buffer.h`, `src/encoded_video_frame_buffer.cpp` | The buffer carries a sequence number. |
| `include/livekit/video_track.h`, `src/video_track.cpp` | The source numbers each encoded frame it emits. |

Each changed file says so in a comment under its license header.
