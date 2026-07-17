//! Windows.Graphics.Capture screen capture → CPU BGRA frames (NGC-03).
//!
//! Single-threaded polling model: `next_frame()` pulls the latest WGC frame, copies its GPU
//! texture into a CPU-readable staging texture, and returns the BGRA bytes. All COM lives on the
//! caller's thread, so there's no Send/Sync dance. The readback is a CPU copy into a reused
//! buffer: it holds 30fps on a real game, and a zero-copy GPU BGRA→NV12 path stays open as a
//! future optimisation rather than a prerequisite.
//!
//! WGC is change-driven: `next_frame()` returns None when nothing has changed since the last frame.

use anyhow::{bail, Context, Result};
use windows::core::{factory, Interface};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind,
    GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::SizeInt32;
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
use windows::Win32::Graphics::Gdi::{
    MonitorFromPoint, MONITOR_DEFAULTTONULL, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindow, IsWindowVisible,
};

/// What we're capturing, kept so we can ask Windows whether it still exists.
///
/// WGC has an event for this — `GraphicsCaptureItem.Closed` — and it does not fire for us:
/// subscribing works, closing the window destroys it (`IsWindow` goes false), and the handler is
/// never called. WinRT wants a DispatcherQueue to deliver it on, and this is a console process with
/// a free-threaded pool and no dispatcher. Measured, not assumed: a probe held a closed window's
/// capture for 30s without a peep. So we ask the OS directly, which costs one syscall a frame.
#[derive(Clone, Copy)]
enum Target {
    /// The raw handle rather than an HWND: HWND is a pointer, which would make the whole capture
    /// un-Send, and the capture is moved to the encode thread.
    Window(isize),
    /// The point the monitor was resolved from — it stops covering it when the display goes away.
    Monitor(POINT),
}

impl Target {
    unsafe fn still_exists(self) -> bool {
        match self {
            Target::Window(handle) => IsWindow(HWND(handle as _)).as_bool(),
            Target::Monitor(at) => !MonitorFromPoint(at, MONITOR_DEFAULTTONULL).is_invalid(),
        }
    }
}

/// One captured frame: BGRA with a possibly-padded row `stride`. Borrowed from the capture's own
/// buffer, which the next `next_frame()` overwrites — copy it if you need it to outlive that.
pub struct BgraFrame<'a> {
    pub data: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

pub struct ScreenCapture {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
    /// Checked every frame: without it a dead source is indistinguishable from a still one (WGC
    /// simply stops delivering), and the share freezes on its last frame forever.
    target: Target,
    /// Readback buffer, reused every frame — a fresh one costs ~8 MB of churn per 1080p frame.
    buf: Vec<u8>,
}

impl ScreenCapture {
    /// Capture the whole primary monitor.
    pub fn primary_monitor() -> Result<Self> {
        unsafe {
            let (device, context, d3d) = device_and_context()?;
            let hmon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = interop.CreateForMonitor(hmon)?;
            Self::build(item, Target::Monitor(POINT { x: 0, y: 0 }), device, context, d3d)
        }
    }

    /// Capture the monitor covering these physical bounds — the one the user picked, which is not
    /// necessarily the primary.
    ///
    /// Matched by the rect's centre, not by exact equality: these bounds reach us through a
    /// DIP→physical conversion, so at fractional scaling (125%, 150%) they can land a pixel off,
    /// and an exact match would fail — silently dropping the user back to the other engine.
    pub fn monitor_by_rect(x: i32, y: i32, width: i32, height: i32) -> Result<Self> {
        unsafe {
            let centre = POINT { x: x + width / 2, y: y + height / 2 };
            let hmon = MonitorFromPoint(centre, MONITOR_DEFAULTTONULL);
            if hmon.is_invalid() {
                bail!("no monitor covers {x},{y} {width}x{height}");
            }
            let (device, context, d3d) = device_and_context()?;
            let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = interop.CreateForMonitor(hmon)?;
            Self::build(item, Target::Monitor(centre), device, context, d3d)
        }
    }

    /// Capture the exact window the user picked. The caller passes the HWND straight from the
    /// picker, so — unlike a title match — it can't land on a different window that happens to
    /// share the title.
    pub fn window_by_handle(handle: isize) -> Result<Self> {
        unsafe {
            let hwnd = HWND(handle as _);
            if !IsWindow(hwnd).as_bool() {
                anyhow::bail!("window {handle} no longer exists");
            }
            let (device, context, d3d) = device_and_context()?;
            let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
            Self::build(item, Target::Window(hwnd.0 as isize), device, context, d3d)
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
            Self::build(item, Target::Window(hwnd.0 as isize), device, context, d3d)
        }
    }

    unsafe fn build(
        item: GraphicsCaptureItem,
        target: Target,
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

        // WGC draws a yellow highlight around whatever it captures. Suppressing it needs the
        // borderless access grant *and* the flag, and both only exist on Win11 21H2+ — on older
        // builds the border simply stays, which is not worth failing a capture over.
        if let Ok(op) = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
            let _ = op.get();
        }
        if let Err(e) = session.SetIsBorderRequired(false) {
            log::warn!("could not hide the capture border: {e}");
        }

        let staging = staging_texture(&device, width, height)?;

        session.StartCapture()?;

        Ok(Self {
            device,
            context,
            _item: item,
            pool,
            session,
            staging,
            width,
            height,
            target,
            buf: Vec::new(),
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Polls the next captured frame.
    ///
    /// `Ok(None)` means nothing new (WGC is change-driven — a still screen delivers nothing), which
    /// is why a caller can't read silence as trouble. `Err` means the source itself is gone.
    pub fn next_frame(&mut self) -> Result<Option<BgraFrame<'_>>> {
        unsafe {
            if !self.target.still_exists() {
                bail!("the captured window or display is gone");
            }
            let Ok(frame) = self.pool.TryGetNextFrame() else {
                return Ok(None);
            };

            // The source can resize under us (a window maximised, a game going borderless, a
            // browser taken fullscreen). The pool keeps handing out textures at its creation size,
            // so without this the content silently arrives cropped or padded with stale pixels.
            let content = frame.ContentSize().unwrap_or_default();
            if content.Width as u32 != self.width || content.Height as u32 != self.height {
                let _ = frame.Close();
                self.resize(content)?;
                // The in-flight frames are the old size; the next one arrives at the new one.
                return Ok(None);
            }

            let Some(src) = frame
                .Surface()
                .ok()
                .and_then(|s| s.cast::<IDirect3DDxgiInterfaceAccess>().ok())
                .and_then(|a| a.GetInterface::<ID3D11Texture2D>().ok())
            else {
                return Ok(None);
            };

            self.context.CopyResource(&self.staging, &src);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if self.context.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).is_err() {
                let _ = frame.Close();
                return Ok(None);
            }
            let stride = mapped.RowPitch as usize;
            let h = self.height as usize;
            let need = stride * h;
            if self.buf.len() != need {
                self.buf.clear();
                self.buf.resize(need, 0);
            }
            std::ptr::copy_nonoverlapping(mapped.pData as *const u8, self.buf.as_mut_ptr(), need);
            self.context.Unmap(&self.staging, 0);

            let _ = frame.Close();
            Ok(Some(BgraFrame { data: &self.buf, width: self.width, height: self.height, stride }))
        }
    }

    /// Rebuild the pool and staging texture for the source's new size.
    ///
    /// The WinRT device is rebuilt here rather than kept as a field: it is the one interface in
    /// this struct that isn't agile, and the struct is moved to the encode thread. Resizes are rare
    /// enough that recreating it costs nothing that matters.
    unsafe fn resize(&mut self, size: SizeInt32) -> Result<()> {
        let (width, height) = (size.Width.max(1) as u32, size.Height.max(1) as u32);
        log::info!("source resized: {}x{} → {width}x{height}", self.width, self.height);

        let d3d = winrt_device(&self.device)?;
        self.pool
            .Recreate(&d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
            .context("recreating the frame pool")?;
        self.staging = staging_texture(&self.device, width, height)?;
        self.width = width;
        self.height = height;
        Ok(())
    }
}

impl Drop for ScreenCapture {
    /// Close the session explicitly: DWM keeps drawing the capture border until it is, and simply
    /// releasing the COM references is not the same thing. A force-killed process never gets here
    /// at all — which is why the app asks the helper to exit instead of terminating it.
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// CPU-readable texture we copy each frame into for readback. Rebuilt whenever the source resizes.
unsafe fn staging_texture(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D> {
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
    staging.context("null staging texture")
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
        let d3d = winrt_device(&device)?;
        Ok((device, context, d3d))
    }
}

/// The WinRT view of a D3D11 device, which is what WGC's pool takes.
unsafe fn winrt_device(device: &ID3D11Device) -> Result<IDirect3DDevice> {
    let dxgi: IDXGIDevice = device.cast()?;
    Ok(CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?)
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


#[cfg(test)]
mod tests {
    use super::Target;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

    // These lock the mechanism that replaced GraphicsCaptureItem.Closed, which never fired for us:
    // a closed source has to be distinguishable from a still one, or the share freezes forever.

    #[test]
    fn should_report_a_window_that_does_not_exist_as_gone() {
        assert!(!unsafe { Target::Window(0xDEAD_BEEF).still_exists() });
    }

    #[test]
    fn should_report_a_live_window_as_present() {
        let desktop = unsafe { GetDesktopWindow() };
        assert!(unsafe { Target::Window(desktop.0 as isize).still_exists() });
    }

    #[test]
    fn should_report_a_point_on_no_monitor_as_gone() {
        assert!(!unsafe { Target::Monitor(POINT { x: 999_999, y: 999_999 }).still_exists() });
    }

    #[test]
    fn should_report_the_primary_monitor_as_present() {
        assert!(unsafe { Target::Monitor(POINT { x: 0, y: 0 }).still_exists() });
    }
}
