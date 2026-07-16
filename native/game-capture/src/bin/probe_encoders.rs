//! probe-encoders — lists this machine's HARDWARE video-encoder MFTs (H264 + H265).
//!
//! NGC-02 context: livekit-rust's prebuilt libwebrtc ships no built-in NVENC
//! (`VideoEncoderBackend::list_available()` → [Auto, Software, PreEncoded]). So we drive a
//! hardware encoder ourselves through Media Foundation and feed encoded frames via the
//! PreEncoded path. MF is vendor-agnostic: whatever the GPU exposes shows up here —
//! NVENC on NVIDIA, AMF on AMD, Quick Sync on Intel. Runs locally, no LiveKit needed.

use windows::core::{GUID, PWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, MFShutdown, MFStartup, MFTEnumEx, MFMediaType_Video, MFVideoFormat_H264,
    MFVideoFormat_HEVC, MFSTARTUP_FULL, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE,
    MFT_ENUM_FLAG_SORTANDFILTER, MFT_FRIENDLY_NAME_Attribute, MFT_REGISTER_TYPE_INFO, MF_VERSION,
};
use windows::Win32::System::Com::CoTaskMemFree;

fn main() {
    unsafe {
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            eprintln!("MFStartup failed: {e}");
            return;
        }
        println!("Hardware video-encoder MFTs on this machine:\n");
        list("H.264", MFVideoFormat_H264);
        list("H.265/HEVC", MFVideoFormat_HEVC);
        let _ = MFShutdown();
    }
}

/// Enumerates hardware encoder MFTs producing `subtype` and prints their friendly names.
unsafe fn list(label: &str, subtype: GUID) {
    let out_type = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: subtype };
    let mut activators: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count: u32 = 0;

    let res = MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
        None,             // any input type
        Some(&out_type),  // this encoded output
        &mut activators,
        &mut count,
    );
    if let Err(e) = res {
        println!("  {label}: enumeration failed: {e}");
        return;
    }
    if count == 0 {
        println!("  {label}: (none)");
    } else {
        let slice = std::slice::from_raw_parts(activators, count as usize);
        for (i, act) in slice.iter().enumerate() {
            let Some(act) = act else { continue };
            let mut name = PWSTR::null();
            let mut len = 0u32;
            if act.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len).is_ok() {
                println!("  {label}[{i}]: {}", name.to_string().unwrap_or_default());
                CoTaskMemFree(Some(name.0 as *const _));
            } else {
                println!("  {label}[{i}]: <unnamed>");
            }
        }
    }
    CoTaskMemFree(Some(activators as *const _));
}
