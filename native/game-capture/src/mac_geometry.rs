//! macOS: a capture source's current geometry, read from CoreGraphics for the follower.
//!
//! ScreenCaptureKit answers the same through `SCShareableContent`, but only by listing every
//! window on the system through its service: about 31 ms, and 6–9 ms of CPU across this process,
//! replayd and WindowServer, per look (measured 2026-10-25 with about 115 windows open). The
//! follower looks twice a second for as long as a share runs. These ask about the one source:
//! about 0.15 ms of CPU per look, or 1.8 ms while a window is off screen (same day, same Mac).

use std::ffi::c_void;

use anyhow::{Context, Result};
use apple_cf::cf::{CFArray, CFDictionary, CFString, CFType};
use apple_cf::cg::{CGRect, Display};

/// A window as the window server has it now.
pub(crate) struct WindowNow {
    /// False for a minimised window, or one on another Space.
    pub on_screen: bool,
    /// Its frame in global points.
    pub frame: CGRect,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut c_void;
}

/// `kCGWindowListOptionAll`: every window, on screen or not.
const ALL_WINDOWS: u32 = 0;
/// `kCGWindowListOptionIncludingWindow` on its own: only the window named, and only while it is on
/// screen (measured 2026-10-25: all 95 off-screen windows came back empty).
const INCLUDING_WINDOW: u32 = 1 << 3;

/// Window `id`, or None once it no longer exists.
pub(crate) fn window(id: u32) -> Result<Option<WindowNow>> {
    if let Some(info) = window_list(INCLUDING_WINDOW, id)?.get(0) {
        return described(&info).map(Some);
    }
    // Off screen, or gone: only the full list tells the two apart. It is the window server's list,
    // not ScreenCaptureKit's, and only a hidden window pays for it.
    for info in window_list(ALL_WINDOWS, 0)?.values() {
        let number = dictionary(&info).and_then(|d| d.get(&CFString::new("kCGWindowNumber"))).and_then(|v| v.as_number());
        if number.and_then(|n| n.to_i64()) == Some(i64::from(id)) {
            return described(&info).map(Some);
        }
    }
    Ok(None)
}

fn window_list(option: u32, relative_to: u32) -> Result<CFArray> {
    // SAFETY: both arguments are plain values. A Copy function returns its array carrying one
    // retain (the Create Rule), which `from_raw` adopts; the null it returns on failure is None.
    unsafe { CFArray::from_raw(CGWindowListCopyWindowInfo(option, relative_to)) }
        .context("the window server returned no window list")
}

/// One entry of a window list.
fn described(info: &CFType) -> Result<WindowNow> {
    let info = dictionary(info).context("window info is not a dictionary")?;
    let bounds = info
        .get(&CFString::new("kCGWindowBounds"))
        .as_ref()
        .and_then(dictionary)
        .context("window info has no bounds")?;
    let number = |key: &str| {
        bounds
            .get(&CFString::new(key))
            .and_then(|v| v.as_number())
            .and_then(|n| n.to_f64())
            .with_context(|| format!("window bounds have no {key}"))
    };
    let frame = CGRect::new(number("X")?, number("Y")?, number("Width")?, number("Height")?);
    // Left out, rather than false, for a window off screen.
    let on_screen = info
        .get(&CFString::new("kCGWindowIsOnscreen"))
        .as_ref()
        .and_then(boolean)
        .unwrap_or(false);
    Ok(WindowNow { on_screen, frame })
}

/// Display `id`'s frame in global points, or None once it is disconnected.
pub(crate) fn display(id: u32) -> Option<CGRect> {
    Display::active().into_iter().find(|d| d.id() == id).map(Display::bounds)
}

pub(crate) fn main_display() -> u32 {
    Display::main().id()
}

/// Pixels per point on the display that holds most of `frame`: a window's backing scale, or a
/// display's own when `frame` is its frame.
pub(crate) fn scale_under(frame: CGRect) -> Option<f64> {
    let displays: Vec<(f64, Display)> = Display::active().into_iter().map(|d| (overlap(d.bounds(), frame), d)).collect();
    let display = most_of(&displays).unwrap_or_else(Display::main);
    let mode = display.mode()?;
    (mode.width() > 0).then(|| mode.pixel_width() as f64 / mode.width() as f64)
}

/// The display covering the most, if any covers anything.
fn most_of(displays: &[(f64, Display)]) -> Option<Display> {
    displays
        .iter()
        .filter(|(area, _)| *area > 0.0)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|&(_, d)| d)
}

/// The area two rectangles share.
fn overlap(a: CGRect, b: CGRect) -> f64 {
    let w = (a.origin.x + a.size.width).min(b.origin.x + b.size.width) - a.origin.x.max(b.origin.x);
    let h = (a.origin.y + a.size.height).min(b.origin.y + b.size.height) - a.origin.y.max(b.origin.y);
    w.max(0.0) * h.max(0.0)
}

/// apple-cf converts a `CFType` to a number but not to a dictionary; this is its `as_number`.
fn dictionary(value: &CFType) -> Option<CFDictionary> {
    if value.type_id() != CFDictionary::type_id() {
        return None;
    }
    // SAFETY: the type id was just checked, and `value` keeps the object alive while it is retained.
    unsafe { CFDictionary::from_raw_borrowed(value.as_ptr()) }
}

/// apple-cf has no CFBoolean.
fn boolean(value: &CFType) -> Option<bool> {
    // SAFETY: CFBooleanGetTypeID takes nothing; CFBooleanGetValue is called only once the type id
    // says `value` is a CFBoolean, and `value` keeps it alive meanwhile.
    unsafe {
        (value.type_id() == apple_cf::raw::CFBooleanGetTypeID() as usize)
            .then(|| apple_cf::raw::CFBooleanGetValue(value.as_ptr().cast()) != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> CGRect {
        CGRect::new(x, y, w, h)
    }

    #[test]
    fn should_measure_the_shared_area_of_two_rectangles() {
        assert_eq!(overlap(rect(0.0, 0.0, 100.0, 100.0), rect(50.0, 50.0, 100.0, 100.0)), 2500.0);
        assert_eq!(overlap(rect(0.0, 0.0, 100.0, 100.0), rect(10.0, 10.0, 20.0, 20.0)), 400.0);
    }

    #[test]
    fn should_find_no_shared_area_when_rectangles_only_touch_or_are_apart() {
        assert_eq!(overlap(rect(0.0, 0.0, 100.0, 100.0), rect(100.0, 0.0, 100.0, 100.0)), 0.0);
        assert_eq!(overlap(rect(0.0, 0.0, 100.0, 100.0), rect(300.0, 300.0, 10.0, 10.0)), 0.0);
    }

    #[test]
    fn should_pick_the_display_holding_most_of_a_window_that_spans_two() {
        let (left, right) = (Display::new(1), Display::new(2));
        assert_eq!(most_of(&[(300.0, left), (700.0, right)]), Some(right));
    }

    #[test]
    fn should_pick_no_display_for_a_window_entirely_off_every_display() {
        assert_eq!(most_of(&[(0.0, Display::new(1)), (0.0, Display::new(2))]), None);
    }
}
