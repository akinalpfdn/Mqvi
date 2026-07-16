//! Vendor-agnostic hardware H264/H265 encoder via a Media Foundation hardware MFT.
//!
//! livekit-rust's prebuilt libwebrtc has no built-in NVENC, so we drive the GPU encoder
//! ourselves and feed the encoded bitstream through livekit's PreEncoded path. MF picks the
//! machine's hardware encoder transparently — NVENC on NVIDIA, AMF on AMD, Quick Sync on Intel.
//!
//! Hardware MFTs are async: after streaming begins, the MFT posts `METransformNeedInput`
//! (feed a frame) and `METransformHaveOutput` (collect a packet) events; we pump them.

use std::mem::ManuallyDrop;

use anyhow::{anyhow, bail, Context, Result};
use windows::core::{Interface, GUID, PWSTR, VARIANT};
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_CBR, ICodecAPI, IMFActivate, IMFMediaEventGenerator, IMFSample,
    IMFTransform, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFStartup, MFTEnumEx,
    CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncVideoForceKeyFrame,
    CODECAPI_AVLowLatencyMode,
    MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS, METransformHaveOutput, METransformNeedInput,
    MFMediaType_Video, MFSampleExtension_CleanPoint, MFSTARTUP_LITE, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_FRIENDLY_NAME_Attribute,
    MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MFVideoFormat_H264,
    MFVideoFormat_HEVC, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MF_MT_AVG_BITRATE,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
    MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
};
use windows::Win32::System::Com::CoTaskMemFree;

const NEED_INPUT: u32 = METransformNeedInput.0 as u32;
const HAVE_OUTPUT: u32 = METransformHaveOutput.0 as u32;

/// One encoded access unit (Annex-B NAL units), as produced by the MFT.
pub struct EncodedPacket {
    pub data: Vec<u8>,
    pub keyframe: bool,
    pub timestamp_us: i64,
}

pub struct HwEncoder {
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    codec_api: Option<ICodecAPI>,
    provides_samples: bool,
    out_size: u32,
    name: String,
}

impl HwEncoder {
    /// Initialize the Media Foundation platform. Call once at startup.
    pub fn startup() -> Result<()> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE).context("MFStartup") }
    }

    pub fn new(width: u32, height: u32, fps: u32, bitrate_bps: u32, hevc: bool) -> Result<Self> {
        unsafe {
            let subtype = if hevc { MFVideoFormat_HEVC } else { MFVideoFormat_H264 };
            let (transform, name) = create_hw_encoder(subtype)?;

            // Unlock the async hardware MFT so we may drive it.
            let attrs = transform.GetAttributes().context("GetAttributes")?;
            attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).context("async unlock")?;

            let codec_api = transform.cast::<ICodecAPI>().ok();
            // Keep the encoder's default periodic IDR interval (~1s). A very long GOP removes the
            // recovery points, so any packet loss accumulates into runaway corruption — far worse
            // than the small periodic keyframe hitch on a low-bitrate stream.

            // Encoders want the OUTPUT type set before the input type.
            let out = MFCreateMediaType()?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate_bps)?;
            out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            transform.SetOutputType(0, &out, 0).context("SetOutputType")?;

            let inp = MFCreateMediaType()?;
            inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            inp.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            inp.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            inp.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            inp.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            transform.SetInputType(0, &inp, 0).context("SetInputType (NV12)")?;

            // Real-time streaming config: low latency (also disables B-frames on NVENC) + CBR.
            match &codec_api {
                Some(api) => {
                    log_set(api, &CODECAPI_AVLowLatencyMode, VARIANT::from(true), "low_latency");
                    log_set(
                        api,
                        &CODECAPI_AVEncCommonRateControlMode,
                        VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32),
                        "cbr",
                    );
                    log_set(api, &CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bitrate_bps), "bitrate");
                }
                None => log::warn!("MFT exposes no ICodecAPI (no low-latency / keyframe control)"),
            }

            let info = transform.GetOutputStreamInfo(0)?;
            let provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32) != 0;

            let events: IMFMediaEventGenerator =
                transform.cast().context("MFT is not an async event generator")?;

            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

            Ok(Self { transform, events, codec_api, provides_samples, out_size: info.cbSize, name })
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Update the target bitrate mid-stream — used to follow WebRTC's bandwidth estimate so the
    /// stream doesn't flood the network (which shows as blocky corruption + endless keyframe asks).
    pub fn set_bitrate(&self, bps: u32) {
        if let Some(api) = &self.codec_api {
            unsafe {
                let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bps));
            }
        }
    }

    /// Feed one NV12 frame; return any packets that became available. Output trails input by the
    /// encoder's pipeline depth — a frame's packet arrives on a later call. Timestamps are µs.
    /// `force_key` makes this frame an IDR — used to answer a WebRTC keyframe request (PLI) so a
    /// subscriber recovers from packet loss instead of ghosting until the next GOP.
    pub fn encode(
        &mut self,
        nv12: &[u8],
        timestamp_us: i64,
        duration_us: i64,
        force_key: bool,
    ) -> Result<Vec<EncodedPacket>> {
        unsafe {
            if force_key {
                if let Some(api) = &self.codec_api {
                    // One-shot: the encoder makes the next input an IDR, then auto-resets.
                    let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
                }
            }
            let mut out = Vec::new();
            loop {
                let ev = self
                    .events
                    .GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0))
                    .context("GetEvent")?;
                match ev.GetType()? {
                    HAVE_OUTPUT => {
                        if let Some(p) = self.pull_output()? {
                            out.push(p);
                        }
                    }
                    NEED_INPUT => {
                        let sample = make_input_sample(nv12, timestamp_us, duration_us)?;
                        self.transform.ProcessInput(0, &sample, 0).context("ProcessInput")?;
                        return Ok(out);
                    }
                    _ => {}
                }
            }
        }
    }

    unsafe fn pull_output(&mut self) -> Result<Option<EncodedPacket>> {
        // If the MFT does not allocate its own output samples, provide one.
        let pre = if self.provides_samples {
            None
        } else {
            let s = MFCreateSample()?;
            s.AddBuffer(&MFCreateMemoryBuffer(self.out_size.max(1))?)?;
            Some(s)
        };
        let mut dbuf = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(pre),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        };
        let mut status = 0u32;
        self.transform
            .ProcessOutput(0, std::slice::from_mut(&mut dbuf), &mut status)
            .context("ProcessOutput")?;

        let sample = ManuallyDrop::into_inner(dbuf.pSample);
        let _ = ManuallyDrop::into_inner(dbuf.pEvents);
        let Some(sample) = sample else { return Ok(None) };

        let ts_100ns = sample.GetSampleTime().unwrap_or(0);
        let keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1;

        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut ptr: *mut u8 = std::ptr::null_mut();
        let mut len = 0u32;
        buffer.Lock(&mut ptr, None, Some(&mut len))?;
        let raw = std::slice::from_raw_parts(ptr, len as usize);
        // Drop Access Unit Delimiter NALs (type 9) — WebRTC's H264 path doesn't emit them; they're
        // the one structural difference from a normal stream and the prime ghosting suspect.
        let data = strip_aud(raw);
        buffer.Unlock()?;

        Ok(Some(EncodedPacket { data, keyframe, timestamp_us: ts_100ns / 10 }))
    }
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | (lo as u64)
}

/// Copies an Annex-B stream, dropping every Access Unit Delimiter NAL (type 9).
fn strip_aud(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    // Collect start-code positions (0x000001 or 0x00000001).
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push((i, 3usize));
            i += 3;
        } else if i + 4 <= data.len() && data[i..i + 4] == [0, 0, 0, 1] {
            starts.push((i, 4usize));
            i += 4;
        } else {
            i += 1;
        }
    }
    if starts.is_empty() {
        return data.to_vec();
    }
    for (idx, &(pos, sc)) in starts.iter().enumerate() {
        let end = starts.get(idx + 1).map(|n| n.0).unwrap_or(data.len());
        let nal_type = data[pos + sc] & 0x1F;
        if nal_type != 9 {
            out.extend_from_slice(&data[pos..end]);
        }
    }
    out
}

unsafe fn log_set(api: &ICodecAPI, guid: &GUID, val: VARIANT, name: &str) {
    match api.SetValue(guid, &val) {
        Ok(()) => log::info!("encoder cfg {name}: ok"),
        Err(e) => log::warn!("encoder cfg {name}: FAILED ({e})"),
    }
}

unsafe fn make_input_sample(nv12: &[u8], ts_us: i64, dur_us: i64) -> Result<IMFSample> {
    let buffer = MFCreateMemoryBuffer(nv12.len() as u32)?;
    let mut ptr: *mut u8 = std::ptr::null_mut();
    buffer.Lock(&mut ptr, None, None)?;
    std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, nv12.len());
    buffer.Unlock()?;
    buffer.SetCurrentLength(nv12.len() as u32)?;

    let sample = MFCreateSample()?;
    sample.AddBuffer(&buffer)?;
    sample.SetSampleTime(ts_us * 10)?; // µs → 100ns
    sample.SetSampleDuration(dur_us * 10)?;
    Ok(sample)
}

/// Enumerates the machine's hardware encoder MFTs for `subtype` and activates the first one.
unsafe fn create_hw_encoder(subtype: GUID) -> Result<(IMFTransform, String)> {
    let out_type = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: subtype };
    let mut activators: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
        None,
        Some(&out_type),
        &mut activators,
        &mut count,
    )
    .context("MFTEnumEx")?;
    if count == 0 || activators.is_null() {
        bail!("no hardware encoder MFT available for this codec");
    }

    let act = (*activators).clone().ok_or_else(|| anyhow!("null activator"))?;

    let mut name = PWSTR::null();
    let mut nlen = 0u32;
    let friendly = if act
        .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut nlen)
        .is_ok()
    {
        let s = name.to_string().unwrap_or_default();
        CoTaskMemFree(Some(name.0 as *const _));
        s
    } else {
        String::new()
    };

    let transform: IMFTransform = act.ActivateObject().context("ActivateObject")?;

    // Release every activator's COM ref, then free the array MF allocated.
    for i in 0..count as usize {
        let _ = std::ptr::read(activators.add(i));
    }
    CoTaskMemFree(Some(activators as *const _));

    Ok((transform, friendly))
}
