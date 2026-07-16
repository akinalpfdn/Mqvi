//! I420 (planar YUV 4:2:0) → NV12 (Y plane + interleaved UV) — the hardware encoder's input.

/// Converts I420 planes to a packed NV12 buffer. `width`/`height` should be even.
pub fn i420_to_nv12(
    y: &[u8],
    u: &[u8],
    v: &[u8],
    width: usize,
    height: usize,
    stride_y: usize,
    stride_u: usize,
    stride_v: usize,
) -> Vec<u8> {
    let cw = width / 2;
    let ch = height / 2;
    let mut out = vec![0u8; width * height + width * ch];

    for row in 0..height {
        let src = &y[row * stride_y..row * stride_y + width];
        out[row * width..row * width + width].copy_from_slice(src);
    }

    let uv_off = width * height;
    for row in 0..ch {
        let us = &u[row * stride_u..row * stride_u + cw];
        let vs = &v[row * stride_v..row * stride_v + cw];
        let dst = &mut out[uv_off + row * width..uv_off + row * width + width];
        for c in 0..cw {
            dst[2 * c] = us[c];
            dst[2 * c + 1] = vs[c];
        }
    }
    out
}

/// Converts a BGRA frame (row `stride`, may be padded) to NV12 via BT.601 limited-range. CPU path
/// for NGC-03 M2 correctness; the shipping path does this on the GPU.
pub fn bgra_to_nv12(bgra: &[u8], width: usize, height: usize, stride: usize) -> Vec<u8> {
    let cw = width / 2;
    let ch = height / 2;
    let mut out = vec![0u8; width * height + width * ch];
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
    out
}

/// Animated NV12 test pattern: horizontal luma gradient, three chroma colour columns, and a
/// white band scrolling down. Same look as the NGC-01 I420 pattern so the viewer test is familiar.
pub fn test_pattern(width: usize, height: usize, frame: u64) -> Vec<u8> {
    let cw = width / 2;
    let ch = height / 2;
    let mut buf = vec![0u8; width * height + width * ch];

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
    buf
}
