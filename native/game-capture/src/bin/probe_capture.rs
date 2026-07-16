//! probe-capture — Windows.Graphics.Capture of the primary monitor into D3D11 textures (NGC-03 M1).
//!
//! Confirms WGC delivers GPU frames and how fast. No encode / no LiveKit — a local check that the
//! capture half works before wiring it to the encoder. Frames arrive on a free-threaded pool (no
//! message loop needed); we just count them and read each texture's descriptor.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::{IInspectable, Interface};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, POINT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11Texture2D, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

fn main() -> windows::core::Result<()> {
    unsafe { run() }
}

unsafe fn run() -> windows::core::Result<()> {
    RoInitialize(RO_INIT_MULTITHREADED)?;

    // D3D11 device — BGRA support is required by WGC.
    let mut device: Option<ID3D11Device> = None;
    D3D11CreateDevice(
        None,
        D3D_DRIVER_TYPE_HARDWARE,
        HMODULE::default(),
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        None,
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        None,
    )?;
    let device = device.expect("D3D11 device");

    // Wrap the D3D11 device as a WinRT IDirect3DDevice for WGC.
    let dxgi: IDXGIDevice = device.cast()?;
    let d3d_device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;

    // GraphicsCaptureItem for the primary monitor (via the Win32 interop factory).
    let hmon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = interop.CreateForMonitor(hmon)?;
    let size = item.Size()?;
    println!("capturing primary monitor: {}x{}", size.Width, size.Height);

    // Free-threaded pool: FrameArrived fires on a threadpool thread — no dispatcher/message loop.
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &d3d_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )?;
    let session = pool.CreateCaptureSession(&item)?;

    let count = Arc::new(AtomicU32::new(0));
    let count_cb = count.clone();
    let handler = TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |pool, _| {
        let pool = pool.as_ref().expect("pool");
        if let Ok(frame) = pool.TryGetNextFrame() {
            // Reaching a real D3D11 texture proves the frame is a GPU surface.
            let _texture: ID3D11Texture2D =
                frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()?;
            let n = count_cb.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 60 == 0 {
                println!("  {n} frames…");
            }
            frame.Close()?;
        }
        Ok(())
    });
    pool.FrameArrived(&handler)?;

    session.StartCapture()?;
    println!("capturing for 5s… (move a window / play a video to see it keep up)");
    let start = Instant::now();
    std::thread::sleep(Duration::from_secs(5));

    session.Close()?;
    pool.Close()?;

    let n = count.load(Ordering::Relaxed);
    let secs = start.elapsed().as_secs_f64();
    println!("captured {n} frames in {secs:.1}s → {:.1} fps", n as f64 / secs);
    Ok(())
}
