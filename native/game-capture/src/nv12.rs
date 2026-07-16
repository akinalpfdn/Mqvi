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
