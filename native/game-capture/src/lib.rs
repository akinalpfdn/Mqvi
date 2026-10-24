//! Shared modules for the native game-capture helper (used by the bins).

pub mod nv12;
pub mod source;

// Windows: WGC capture, Media Foundation hardware encode, DXGI display state, D3D11 tone-map.
#[cfg(windows)]
pub mod capture;
#[cfg(windows)]
pub mod display_light;
#[cfg(windows)]
pub mod mf_encoder;
#[cfg(windows)]
pub mod tonemap;

// macOS: ScreenCaptureKit capture, encoded by libwebrtc's own VideoToolbox backend.
#[cfg(target_os = "macos")]
pub mod mac_audio;
#[cfg(target_os = "macos")]
pub mod mac_capture;
