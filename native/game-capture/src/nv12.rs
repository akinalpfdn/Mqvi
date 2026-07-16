//! I420 (planar YUV 4:2:0) → NV12 (Y plane + interleaved UV) — the hardware encoder's input.

/// Size of the NV12 buffer for a `width`x`height` frame.
fn nv12_len(width: usize, height: usize) -> usize {
    width * height + width * (height / 2)
}

/// Converts a BGRA frame (row `stride`, may be padded) to NV12 via BT.601 limited-range, reusing
/// `out`. This is the shipping path: it runs on the CPU for every frame, so the caller keeps one
/// buffer across frames rather than allocating ~3 MB per frame in the process that must not steal
/// from the game. (Doing the conversion on the GPU would drop the readback entirely — an
/// optimisation, not a correctness fix.)
pub fn bgra_to_nv12_into(
    bgra: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    out: &mut Vec<u8>,
) {
    let cw = width / 2;
    let ch = height / 2;
    let need = nv12_len(width, height);
    if out.len() != need {
        out.clear();
        out.resize(need, 0);
    }
    let uv_off = width * height;

    for y in 0..height {
        let row = y * stride;
        for x in 0..width {
            let i = row + x * 4;
            let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
            let yv = 0.257 * r + 0.504 * g + 0.098 * b + 16.0;
            out[y * width + x] = yv.clamp(0.0, 255.0) as u8;
        }
    }
    // Chroma subsampled 2:1 — sample each 2x2 block's top-left pixel.
    for cy in 0..ch {
        for cx in 0..cw {
            let i = (cy * 2) * stride + (cx * 2) * 4;
            let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
            let u = -0.148 * r - 0.291 * g + 0.439 * b + 128.0;
            let v = 0.439 * r - 0.368 * g - 0.071 * b + 128.0;
            out[uv_off + cy * width + cx * 2] = u.clamp(0.0, 255.0) as u8;
            out[uv_off + cy * width + cx * 2 + 1] = v.clamp(0.0, 255.0) as u8;
        }
    }
}

/// Allocating form of [`bgra_to_nv12_into`], for one-shot callers (probes, tests).
pub fn bgra_to_nv12(bgra: &[u8], width: usize, height: usize, stride: usize) -> Vec<u8> {
    let mut out = Vec::new();
    bgra_to_nv12_into(bgra, width, height, stride, &mut out);
    out
}

/// Animated NV12 test pattern into a reused `buf`: horizontal luma gradient, three chroma colour
/// columns, and a white band scrolling down. Same look as the NGC-01 I420 pattern so the viewer
/// test is familiar.
pub fn test_pattern_into(width: usize, height: usize, frame: u64, buf: &mut Vec<u8>) {
    let cw = width / 2;
    let ch = height / 2;
    let need = nv12_len(width, height);
    if buf.len() != need {
        buf.clear();
        buf.resize(need, 0);
    }

    let band = (frame as usize * 4) % height;
    let band_h = (height / 10).max(1);
    for y in 0..height {
        for x in 0..width {
            buf[y * width + x] = if y >= band && y < band + band_h {
                235
            } else {
                (40 + x * 215 / width.max(1)) as u8
            };
        }
    }

    let uv = width * height;
    for cy in 0..ch {
        for cx in 0..cw {
            let (u, v) = match cx * 3 / cw.max(1) {
                0 => (240u8, 110u8),
                1 => (90, 240),
                _ => (110, 90),
            };
            buf[uv + cy * width + 2 * cx] = u;
            buf[uv + cy * width + 2 * cx + 1] = v;
        }
    }
}

/// Allocating form of [`test_pattern_into`], for one-shot callers (probes, tests).
pub fn test_pattern(width: usize, height: usize, frame: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    test_pattern_into(width, height, frame, &mut buf);
    buf
}
