//! What a monitor is doing with light right now: whether Windows runs it in HDR, where it puts SDR
//! white, and how bright it peaks. The capture needs all three to bring an HDR desktop down to SDR
//! without blowing it out — see `tonemap`.

use anyhow::{bail, Context, Result};
use windows::core::Interface;
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SDR_WHITE_LEVEL, DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput6, DXGI_OUTPUT_DESC1,
};
use windows::Win32::Graphics::Gdi::HMONITOR;

/// scRGB's unit: 1.0 is 80 nits.
pub const SCRGB_UNIT_NITS: f32 = 80.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayLight {
    pub hdr: bool,
    pub sdr_white_nits: f32,
    pub peak_nits: f32,
}

/// Asks Windows about the monitor `hmon` is on.
///
/// Errors when the monitor is in HDR but its SDR white level cannot be read: without it there is no
/// right brightness to map to, and the caller is better off on the plain 8-bit capture it had.
pub fn query(hmon: HMONITOR) -> Result<DisplayLight> {
    unsafe {
        let desc = output_desc(hmon)?;
        if desc.ColorSpace != DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020 {
            return Ok(DisplayLight {
                hdr: false,
                sdr_white_nits: SCRGB_UNIT_NITS,
                peak_nits: SCRGB_UNIT_NITS,
            });
        }
        let sdr_white_nits = sdr_white_nits(&desc.DeviceName)?;
        // Some monitors report nothing usable here; treating their peak as SDR white means
        // highlights are clipped rather than compressed, which is the safe direction.
        let peak_nits = if desc.MaxLuminance.is_finite() && desc.MaxLuminance > sdr_white_nits {
            desc.MaxLuminance
        } else {
            sdr_white_nits
        };
        Ok(DisplayLight { hdr: true, sdr_white_nits, peak_nits })
    }
}

/// Whether any attached monitor is in HDR — what the app asks before a sharp share, which it then
/// routes to the helper's tone-mapping engine instead of the browser's clipping one.
pub fn any_hdr() -> Result<bool> {
    unsafe {
        Ok(outputs()?
            .iter()
            .any(|d| d.AttachedToDesktop.as_bool() && d.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020))
    }
}

/// The DXGI output driving `hmon`.
unsafe fn output_desc(hmon: HMONITOR) -> Result<DXGI_OUTPUT_DESC1> {
    outputs()?
        .into_iter()
        .find(|d| d.Monitor == hmon)
        .context("no DXGI output drives this monitor")
}

/// Every output on every adapter: on a hybrid laptop a monitor may hang off a different GPU than
/// the one we capture with.
unsafe fn outputs() -> Result<Vec<DXGI_OUTPUT_DESC1>> {
    let factory: IDXGIFactory1 = CreateDXGIFactory1().context("CreateDXGIFactory1")?;
    let mut found = Vec::new();
    let mut a = 0;
    while let Ok(adapter) = factory.EnumAdapters1(a) {
        let mut o = 0;
        while let Ok(output) = adapter.EnumOutputs(o) {
            if let Ok(desc) = output.cast::<IDXGIOutput6>().and_then(|out| out.GetDesc1()) {
                found.push(desc);
            }
            o += 1;
        }
        a += 1;
    }
    Ok(found)
}

/// The "SDR content brightness" slider of the display whose GDI name is `gdi_name`, in nits.
unsafe fn sdr_white_nits(gdi_name: &[u16; 32]) -> Result<f32> {
    let (mut paths_len, mut modes_len) = (0u32, 0u32);
    let err = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths_len, &mut modes_len);
    if err.0 != 0 {
        bail!("GetDisplayConfigBufferSizes failed: {}", err.0);
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); paths_len as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); modes_len as usize];
    let err = QueryDisplayConfig(
        QDC_ONLY_ACTIVE_PATHS,
        &mut paths_len,
        paths.as_mut_ptr(),
        &mut modes_len,
        modes.as_mut_ptr(),
        None,
    );
    if err.0 != 0 {
        bail!("QueryDisplayConfig failed: {}", err.0);
    }
    paths.truncate(paths_len as usize);

    for path in &paths {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            },
            ..Default::default()
        };
        if DisplayConfigGetDeviceInfo(&mut source.header) != 0
            || !same_name(&source.viewGdiDeviceName, gdi_name)
        {
            continue;
        }
        let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
                size: std::mem::size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32,
                adapterId: path.targetInfo.adapterId,
                id: path.targetInfo.id,
            },
            ..Default::default()
        };
        let err = DisplayConfigGetDeviceInfo(&mut white.header);
        if err != 0 {
            bail!("reading the SDR white level failed: {err}");
        }
        return Ok(nits_from_white_level(white.SDRWhiteLevel));
    }
    bail!("no active display path matches this monitor")
}

/// `SDRWhiteLevel` is in thousandths of scRGB's 80-nit unit (1000 = 80 nits).
pub fn nits_from_white_level(raw: u32) -> f32 {
    raw as f32 / 1000.0 * SCRGB_UNIT_NITS
}

/// GDI device names are NUL-terminated inside a fixed buffer.
fn same_name(a: &[u16; 32], b: &[u16; 32]) -> bool {
    let end = |s: &[u16; 32]| s.iter().position(|&c| c == 0).unwrap_or(s.len());
    a[..end(a)] == b[..end(b)]
}

#[cfg(test)]
mod tests {
    use super::{nits_from_white_level, same_name};

    fn name(s: &str) -> [u16; 32] {
        let mut out = [0u16; 32];
        for (i, c) in s.encode_utf16().enumerate() {
            out[i] = c;
        }
        out
    }

    #[test]
    fn should_read_1000_as_80_nits() {
        assert_eq!(nits_from_white_level(1000), 80.0);
    }

    #[test]
    fn should_read_the_default_slider_position_as_its_nits() {
        assert_eq!(nits_from_white_level(2500), 200.0);
    }

    #[test]
    fn should_match_names_regardless_of_what_follows_the_terminator() {
        let mut a = name(r"\\.\DISPLAY1");
        a[20] = 0x41; // garbage past the NUL
        assert!(same_name(&a, &name(r"\\.\DISPLAY1")));
    }

    #[test]
    fn should_not_match_a_name_that_is_only_a_prefix() {
        assert!(!same_name(&name(r"\\.\DISPLAY1"), &name(r"\\.\DISPLAY12")));
    }
}
