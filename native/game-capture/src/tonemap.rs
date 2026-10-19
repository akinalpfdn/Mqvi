//! HDR → SDR on the GPU, between WGC and the BGRA readback.
//!
//! A monitor in HDR is composed in scRGB: linear light where 1.0 is 80 nits, SDR content sits at
//! the user's SDR white level, and HDR content (video, games, Auto HDR) goes well past it. Asking
//! WGC for 8-bit makes Windows clip all of that at 80 nits, which is the "gamma maxed" stream. We
//! capture FP16 instead and map it here: scale so SDR white lands on 1.0, compress what is brighter
//! into the top of the range, and encode sRGB — the bytes the 8-bit path would have produced for SDR
//! content, without the clipping for everything else.

use anyhow::{bail, Context, Result};
use windows::core::{s, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::ID3DBlob;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Buffer, ID3D11ComputeShader, ID3D11Device, ID3D11DeviceContext,
    ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11UnorderedAccessView,
    D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_UNORDERED_ACCESS,
    D3D11_BUFFER_DESC, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC,
};

use crate::display_light::{DisplayLight, SCRGB_UNIT_NITS};

/// The format WGC hands us when asked for FP16, and the one the shader reads.
pub const HDR_FORMAT: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT =
    DXGI_FORMAT_R16G16B16A16_FLOAT;
/// What the shader writes. RGBA8 rather than BGRA8 because typed UAV stores to BGRA8 are optional
/// in D3D11 — the shader swaps channels instead, so the bytes still read B,G,R,A.
pub const SDR_FORMAT: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT =
    DXGI_FORMAT_R8G8B8A8_UNORM;

/// Where compression starts, as a fraction of SDR white. Everything below is passed through
/// untouched; above it, the range up to the display's peak is folded into what is left. Any value
/// under 1.0 dims SDR white slightly (0.9 puts it at ~249/255) — the price of having somewhere to
/// put highlights at all. At 1.0 they would simply clip, flat and colourless.
const KNEE: f32 = 0.9;

const SHADER: &str = r#"
Texture2D<float4> src : register(t0);
RWTexture2D<unorm float4> dst : register(u0);

cbuffer Params : register(b0) {
    float scale;
    float knee;
    float k;
    float pad0;
    uint2 size;
    uint2 pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID) {
    if (id.x >= size.x || id.y >= size.y) return;

    // Negative scRGB is colour outside sRGB's gamut; it has nowhere to go in 8-bit.
    float3 c = max(src[id.xy].rgb * scale, 0.0);

    // Compress on the brightest channel and scale all three by the same ratio, so a highlight keeps
    // its hue instead of washing out to white channel by channel.
    float m = max(c.r, max(c.g, c.b));
    if (m > knee) {
        float e = m - knee;
        c *= (knee + e / (1.0 + k * e)) / m;
    }
    c = saturate(c);

    float3 s = c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
    dst[id.xy] = float4(s.b, s.g, s.r, 1.0);
}
"#;

/// The shader's constants, laid out as its cbuffer (16-byte rows).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToneParams {
    scale: f32,
    knee: f32,
    k: f32,
    pad0: f32,
    size: [u32; 2],
    pad1: [u32; 2],
}

impl ToneParams {
    /// `scale` brings SDR white to 1.0. `k` shapes `knee + e / (1 + k·e)` so it leaves the knee at
    /// slope 1 (no visible seam) and reaches exactly 1.0 at the display's peak; past the peak it
    /// keeps rising, ever more slowly, and the saturate catches the last sliver.
    pub fn new(light: DisplayLight) -> Self {
        let white = light.sdr_white_nits.max(1.0);
        let peak = (light.peak_nits / white).max(1.0);
        // peak == 1 gives k == 0: no headroom to compress into, so plain pass-through and clip.
        let k = 1.0 / (1.0 - KNEE) - 1.0 / (peak - KNEE);
        Self { scale: SCRGB_UNIT_NITS / white, knee: KNEE, k, pad0: 0.0, size: [0; 2], pad1: [0; 2] }
    }
}

pub struct HdrToSdr {
    shader: ID3D11ComputeShader,
    params: ID3D11Buffer,
    /// Our own copy of each WGC frame: the pool's textures are not ours to bind as shader input.
    input: Option<(ID3D11Texture2D, ID3D11ShaderResourceView)>,
    output: Option<(ID3D11Texture2D, ID3D11UnorderedAccessView)>,
    size: (u32, u32),
}

impl HdrToSdr {
    pub fn new(device: &ID3D11Device) -> Result<Self> {
        unsafe {
            let bytecode = compile(SHADER, s!("main"), s!("cs_5_0"))?;
            let mut shader = None;
            device
                .CreateComputeShader(blob_bytes(&bytecode), None, Some(&mut shader))
                .context("CreateComputeShader")?;

            let desc = D3D11_BUFFER_DESC {
                ByteWidth: std::mem::size_of::<ToneParams>() as u32,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                ..Default::default()
            };
            let mut params = None;
            device.CreateBuffer(&desc, None, Some(&mut params)).context("tone-map constants")?;

            Ok(Self {
                shader: shader.context("null compute shader")?,
                params: params.context("null constant buffer")?,
                input: None,
                output: None,
                size: (0, 0),
            })
        }
    }

    /// Tone-maps `frame` (FP16 scRGB, `width`x`height`) and returns the RGBA8 texture holding the
    /// result. That texture is reused, so it is only valid until the next call.
    pub fn convert(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        frame: &ID3D11Texture2D,
        width: u32,
        height: u32,
        params: ToneParams,
    ) -> Result<&ID3D11Texture2D> {
        unsafe {
            if self.size != (width, height) || self.input.is_none() || self.output.is_none() {
                self.input = Some(input_texture(device, width, height)?);
                self.output = Some(output_texture(device, width, height)?);
                self.size = (width, height);
            }
            let (Some((input, srv)), Some((output, uav))) = (&self.input, &self.output) else {
                bail!("tone-map textures missing");
            };

            context.CopyResource(input, frame);

            let params = ToneParams { size: [width, height], ..params };
            context.UpdateSubresource(&self.params, 0, None, &params as *const _ as _, 0, 0);

            context.CSSetShader(&self.shader, None);
            context.CSSetShaderResources(0, Some(&[Some(srv.clone())]));
            context.CSSetUnorderedAccessViews(0, 1, Some(&Some(uav.clone())), None);
            context.CSSetConstantBuffers(0, Some(&[Some(self.params.clone())]));
            context.Dispatch(width.div_ceil(8), height.div_ceil(8), 1);

            // Unbound so the next CopyResource out of `output` is not reading a texture the
            // pipeline still holds for writing.
            context.CSSetUnorderedAccessViews(0, 1, Some(&None), None);
            context.CSSetShaderResources(0, Some(&[None]));

            Ok(output)
        }
    }
}

unsafe fn input_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, ID3D11ShaderResourceView)> {
    let tex = texture(device, width, height, HDR_FORMAT, D3D11_BIND_SHADER_RESOURCE.0 as u32)?;
    let mut srv = None;
    device.CreateShaderResourceView(&tex, None, Some(&mut srv)).context("tone-map input view")?;
    Ok((tex, srv.context("null input view")?))
}

unsafe fn output_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, ID3D11UnorderedAccessView)> {
    let tex = texture(device, width, height, SDR_FORMAT, D3D11_BIND_UNORDERED_ACCESS.0 as u32)?;
    let mut uav = None;
    device.CreateUnorderedAccessView(&tex, None, Some(&mut uav)).context("tone-map output view")?;
    Ok((tex, uav.context("null output view")?))
}

unsafe fn texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    bind: u32,
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut tex = None;
    device.CreateTexture2D(&desc, None, Some(&mut tex)).context("tone-map texture")?;
    tex.context("null tone-map texture")
}

/// Compiled at start-up from source: d3dcompiler_47 ships with every Windows this runs on, and it
/// keeps the shader readable next to the code that feeds it. Costs a few milliseconds, once.
unsafe fn compile(source: &str, entry: PCSTR, target: PCSTR) -> Result<ID3DBlob> {
    let mut code = None;
    let mut errors = None;
    let result = D3DCompile(
        source.as_ptr() as _,
        source.len(),
        s!("tonemap.hlsl"),
        None,
        None,
        entry,
        target,
        0,
        0,
        &mut code,
        Some(&mut errors),
    );
    if let Err(e) = result {
        let detail = errors
            .map(|b| String::from_utf8_lossy(blob_bytes(&b)).into_owned())
            .unwrap_or_default();
        bail!("compiling the tone-map shader: {e} {detail}");
    }
    code.context("shader compiler returned no code")
}

unsafe fn blob_bytes(blob: &ID3DBlob) -> &[u8] {
    std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize())
}

#[cfg(test)]
mod tests {
    use super::{HdrToSdr, ToneParams, HDR_FORMAT, SDR_FORMAT};
    use crate::display_light::DisplayLight;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_WARP;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_FLAG, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
        D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
        D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;

    // These run the real shader on WARP, Windows' software rasteriser: same HLSL, same compiler,
    // no GPU needed — so a wrong curve, swapped channels or a missed edge pixel fails here rather
    // than on someone's stream.

    /// SDR white at 240 nits, peaking at 720: the slider at a common spot on a typical HDR monitor.
    const LIGHT: DisplayLight = DisplayLight { hdr: true, sdr_white_nits: 240.0, peak_nits: 720.0 };
    /// scRGB value of SDR white under LIGHT.
    const WHITE: f32 = 240.0 / 80.0;

    fn warp() -> (ID3D11Device, ID3D11DeviceContext) {
        unsafe {
            let (mut device, mut context) = (None, None);
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_FLAG(0),
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .expect("WARP device");
            (device.unwrap(), context.unwrap())
        }
    }

    /// f32 → IEEE half, for the normal-range values these tests use.
    fn half(v: f32) -> u16 {
        if v == 0.0 {
            return 0;
        }
        let bits = v.to_bits();
        let sign = ((bits >> 16) & 0x8000) as u16;
        let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
        let mant = ((bits >> 13) & 0x3ff) as u16;
        sign | ((exp as u16) << 10) | mant
    }

    /// Runs the converter over `pixels` (scRGB RGB triples, row-major) and returns the output bytes.
    fn run(pixels: &[[f32; 3]], width: u32, height: u32, light: DisplayLight) -> Vec<[u8; 4]> {
        unsafe {
            let (device, context) = warp();
            let data: Vec<u16> =
                pixels.iter().flat_map(|p| [half(p[0]), half(p[1]), half(p[2]), half(1.0)]).collect();
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: HDR_FORMAT,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                ..Default::default()
            };
            let init = D3D11_SUBRESOURCE_DATA {
                pSysMem: data.as_ptr() as _,
                SysMemPitch: width * 8,
                SysMemSlicePitch: 0,
            };
            let mut frame: Option<ID3D11Texture2D> = None;
            device.CreateTexture2D(&desc, Some(&init), Some(&mut frame)).unwrap();
            let frame = frame.unwrap();

            let mut tm = HdrToSdr::new(&device).expect("shader compiles");
            let out = tm.convert(&device, &context, &frame, width, height, ToneParams::new(light)).unwrap();

            let staging_desc = D3D11_TEXTURE2D_DESC {
                Format: SDR_FORMAT,
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..desc
            };
            let mut staging: Option<ID3D11Texture2D> = None;
            device.CreateTexture2D(&staging_desc, None, Some(&mut staging)).unwrap();
            let staging = staging.unwrap();
            context.CopyResource(&staging, out);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).unwrap();
            let mut px = Vec::new();
            for y in 0..height as usize {
                let row = (mapped.pData as *const u8).add(y * mapped.RowPitch as usize);
                for x in 0..width as usize {
                    let p = row.add(x * 4);
                    px.push([*p, *p.add(1), *p.add(2), *p.add(3)]);
                }
            }
            context.Unmap(&staging, 0);
            px
        }
    }

    fn one(rgb: [f32; 3]) -> [u8; 4] {
        run(&[rgb], 1, 1, LIGHT)[0]
    }

    fn srgb8(linear: f32) -> u8 {
        let s = if linear <= 0.0031308 { 12.92 * linear } else { 1.055 * linear.powf(1.0 / 2.4) - 0.055 };
        (s * 255.0).round() as u8
    }

    #[test]
    fn should_leave_content_below_the_knee_exactly_as_sdr() {
        // Half of SDR white: plain sRGB encoding, nothing else touched.
        let px = one([WHITE * 0.5; 3]);
        let want = srgb8(0.5);
        for c in &px[..3] {
            assert!((*c as i16 - want as i16).abs() <= 1, "got {px:?}, want {want}");
        }
    }

    #[test]
    fn should_keep_sdr_white_near_white() {
        let px = one([WHITE; 3]);
        assert!(px[..3].iter().all(|&c| c >= 245), "SDR white came out {px:?}");
    }

    /// The bug: an 8-bit capture clips this to 255 along with everything else above 80 nits.
    #[test]
    fn should_keep_hdr_highlights_below_and_distinct_from_the_peak() {
        let diffuse = one([WHITE * 1.2; 3])[0];
        let peak = one([WHITE * 3.0; 3])[0];
        assert!(diffuse < peak, "brighter must stay brighter: {diffuse} vs {peak}");
        assert!(peak >= 250, "the display's peak should reach the top: {peak}");
    }

    #[test]
    fn should_keep_a_highlights_hue_instead_of_bleaching_it() {
        // Bright orange well past SDR white: per-channel clipping would turn it yellow-white.
        let [b, g, r, _] = one([WHITE * 3.0, WHITE * 1.5, 0.0]);
        assert_eq!(b, 0);
        assert!(r > g && g > 150, "orange must stay orange: r={r} g={g}");
        assert!(r - g > 40, "and not flatten towards yellow: r={r} g={g}");
    }

    #[test]
    fn should_write_bytes_in_bgra_order() {
        let px = one([WHITE * 0.5, 0.0, 0.0]);
        assert_eq!(px[0], 0, "blue byte");
        assert_eq!(px[1], 0, "green byte");
        assert!(px[2] > 150, "red lands in the third byte: {px:?}");
        assert_eq!(px[3], 255, "opaque alpha");
    }

    #[test]
    fn should_clamp_out_of_gamut_negatives_to_zero() {
        let px = one([-0.5, WHITE * 0.5, WHITE * 0.5]);
        assert_eq!(px[2], 0, "negative red must be 0, not wrap: {px:?}");
    }

    /// Dispatch rounds up to 8x8 groups; an edge the bounds check mishandles stays black.
    #[test]
    fn should_write_every_pixel_of_a_frame_not_a_multiple_of_the_group_size() {
        let (w, h) = (13, 7);
        let px = run(&vec![[WHITE * 0.5; 3]; (w * h) as usize], w, h, LIGHT);
        assert!(px.iter().all(|p| p[0] > 100 && p[3] == 255), "an edge pixel was skipped");
    }

    #[test]
    fn should_pass_through_and_clip_when_the_display_has_no_headroom() {
        let flat = DisplayLight { hdr: true, sdr_white_nits: 240.0, peak_nits: 240.0 };
        let p = ToneParams::new(flat);
        assert_eq!(p.k, 0.0, "no compression without headroom");
        let px = run(&[[WHITE; 3]], 1, 1, flat)[0];
        assert_eq!(px[0], 255, "SDR white stays white when nothing needs the room");
    }
}
