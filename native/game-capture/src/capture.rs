//! Windows.Graphics.Capture screen capture → CPU BGRA frames (NGC-03).
//!
//! Single-threaded polling model: `next_frame()` pulls the latest WGC frame, copies its GPU
//! texture into a CPU-readable staging texture, and returns the BGRA bytes. All COM lives on the
//! caller's thread, so there's no Send/Sync dance. (M3 replaces the CPU readback with a zero-copy
//! GPU BGRA→NV12 path; this is the correct-but-copying stepping stone.)
//!
//! WGC is change-driven: `next_frame()` returns None when nothing has changed since the last frame.

use anyhow::{Context, Result};
use windows::core::{factory, Interface};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{BOOL, HMODULE, HWND, LPARAM, POINT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
};

/// One captured frame: tightly-addressable BGRA with a possibly-padded row `stride`.
pub struct BgraFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

pub struct ScreenCapture {
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    _session: GraphicsCaptureSession,
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
}

impl ScreenCapture {
    /// Capture the whole primary monitor.
    pub fn primary_monitor() -> Result<Self> {
        unsafe {
            let (device, context, d3d) = device_and_context()?;
            let hmon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = interop.CreateForMonitor(hmon)?;
            Self::build(item, device, context, d3d)
        }
    }

    /// Capture a single window whose title contains `needle` (case-insensitive) — e.g. a game.
    /// Capturing just the window (not the desktop) avoids the mirror feedback loop when the viewer
    /// is on the same monitor, and is the right shape for game streaming.
    pub fn window_by_title(needle: &str) -> Result<Self> {
        unsafe {
            let hwnd = find_window_by_title(needle)
                .with_context(|| format!("no visible window matching '{needle}'"))?;
            let (device, context, d3d) = device_and_context()?;
            let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
            Self::build(item, device, context, d3d)
        }
    }

    unsafe fn build(
        item: GraphicsCaptureItem,
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        d3d: IDirect3DDevice,
    ) -> Result<Self> {
        let size = item.Size()?;
        let (width, height) = (size.Width as u32, size.Height as u32);

        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &d3d,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;

        // CPU-readable staging texture we copy each frame into for readback.
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        device.CreateTexture2D(&desc, None, Some(&mut staging)).context("staging texture")?;
        let staging = staging.context("null staging texture")?;

        session.StartCapture()?;

        Ok(Self {
            _device: device,
            context,
            _item: item,
            pool,
            _session: session,
            staging,
            width,
            height,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Polls the next captured frame; None if nothing new (WGC is change-driven).
    pub fn next_frame(&self) -> Option<BgraFrame> {
        unsafe {
            let frame = self.pool.TryGetNextFrame().ok()?;
            let src: ID3D11Texture2D = frame
                .Surface()
                .ok()?
                .cast::<IDirect3DDxgiInterfaceAccess>()
                .ok()?
                .GetInterface()
                .ok()?;

            self.context.CopyResource(&self.staging, &src);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .ok()?;
            let stride = mapped.RowPitch as usize;
            let h = self.height as usize;
            let mut data = vec![0u8; stride * h];
            std::ptr::copy_nonoverlapping(mapped.pData as *const u8, data.as_mut_ptr(), stride * h);
            self.context.Unmap(&self.staging, 0);

            let _ = frame.Close();
            Some(BgraFrame { data, width: self.width, height: self.height, stride })
        }
    }
}

fn device_and_context() -> Result<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice)> {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED); // best-effort; MF may have set MTA already
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .context("D3D11CreateDevice")?;
        let device = device.context("null D3D11 device")?;
        let context = context.context("null D3D11 context")?;
        let dxgi: IDXGIDevice = device.cast()?;
        let d3d: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
        Ok((device, context, d3d))
    }
}

struct FindCtx {
    needle: String,
    found: Option<HWND>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut FindCtx);
    if IsWindowVisible(hwnd).as_bool() {
        let len = GetWindowTextLengthW(hwnd);
        if len > 0 {
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            if title.to_lowercase().contains(&ctx.needle) {
                ctx.found = Some(hwnd);
                return BOOL(0); // stop enumeration
            }
        }
    }
    BOOL(1) // continue
}

fn find_window_by_title(needle: &str) -> Option<HWND> {
    let mut ctx = FindCtx { needle: needle.to_lowercase(), found: None };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut _ as isize));
    }
    ctx.found
}
