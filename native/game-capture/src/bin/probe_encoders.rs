//! probe-encoders — prints this machine's hardware video-encoder MFTs (H264 + H265).
//!
//! NGC-02 context: livekit-rust's prebuilt libwebrtc ships no built-in NVENC
//! (`VideoEncoderBackend::list_available()` → [Auto, Software, PreEncoded]). So we drive a
//! hardware encoder ourselves through Media Foundation and feed encoded frames via the
//! PreEncoded path. MF is vendor-agnostic: whatever the GPU exposes shows up here —
//! NVENC on NVIDIA, AMF on AMD, Quick Sync on Intel. Runs locally, no LiveKit needed.
//!
//! Calls the same function the helper puts in its failure report, so what an operator reads in
//! `app_logs` is what this prints — no second implementation to drift.

use mqvi_game_capture::mf_encoder::describe_hardware_encoders;

fn main() {
    println!("{}", describe_hardware_encoders());
}
