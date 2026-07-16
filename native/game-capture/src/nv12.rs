//! I420 (planar YUV 4:2:0) → NV12 (Y plane + interleaved UV) — the hardware encoder's input.

/// BT.601 limited-range, in integers. The float form costs three divisions and three multiplies per
/// pixel; at 1440p30 that is 110M float ops a second on the CPU of a machine that is running a game.
/// These are the standard fixed-point coefficients — same output, a fraction of the work.
#[inline(always)]
fn luma(b: u32, g: u32, r: u32) -> u8 {
    (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8
}

#[inline(always)]
fn chroma(b: u32, g: u32, r: u32) -> (u8, u8) {
    let u = ((-38 * r as i32 - 74 * g as i32 + 112 * b as i32 + 128) >> 8) + 128;
    let v = ((112 * r as i32 - 94 * g as i32 - 18 * b as i32 + 128) >> 8) + 128;
    (u.clamp(0, 255) as u8, v.clamp(0, 255) as u8)
}

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
        let dst = &mut out[y * width..y * width + width];
        for (x, d) in dst.iter_mut().enumerate() {
            let i = row + x * 4;
            *d = luma(bgra[i] as u32, bgra[i + 1] as u32, bgra[i + 2] as u32);
        }
    }
    // Chroma subsampled 2:1 — sample each 2x2 block's top-left pixel.
    for cy in 0..ch {
        for cx in 0..cw {
            let i = (cy * 2) * stride + (cx * 2) * 4;
            let (u, v) = chroma(bgra[i] as u32, bgra[i + 1] as u32, bgra[i + 2] as u32);
            out[uv_off + cy * width + cx * 2] = u;
            out[uv_off + cy * width + cx * 2 + 1] = v;
        }
    }
}

/// The largest even-sized rect with `src`'s aspect that fits in `dst`, and its centred offset.
/// Even because NV12 chroma is subsampled 2:1 — an odd offset would split a chroma pair.
fn fit_rect(src_w: usize, src_h: usize, dst_w: usize, dst_h: usize) -> (usize, usize, usize, usize) {
    if src_w == 0 || src_h == 0 {
        return (0, 0, 0, 0);
    }
    let by_width = (dst_h * src_w).min(dst_w * src_h) == dst_w * src_h;
    let (w, h) = if by_width {
        (dst_w, (dst_w * src_h / src_w).max(1))
    } else {
        ((dst_h * src_w / src_h).max(1), dst_h)
    };
    let (w, h) = ((w.min(dst_w)) & !1, (h.min(dst_h)) & !1);
    (w, h, ((dst_w - w) / 2) & !1, ((dst_h - h) / 2) & !1)
}

/// Scales a BGRA frame into an NV12 canvas of `dst_w`x`dst_h`, keeping the source's aspect and
/// letterboxing what's left.
///
/// Box-averaged rather than nearest: a nearest-neighbour downscale of text and UI aliases into a
/// shimmering mess, and averaging costs the same order — both read the source once.
///
/// This is what decouples the stream's size from the window's. Without it the two are the same
/// number, so a resized window means a resized stream (or, as it did, a silently cropped one).
#[allow(clippy::too_many_arguments)]
pub fn bgra_to_nv12_fit_into(
    bgra: &[u8],
    src_w: usize,
    src_h: usize,
    stride: usize,
    dst_w: usize,
    dst_h: usize,
    out: &mut Vec<u8>,
) {
    let need = nv12_len(dst_w, dst_h);
    if out.len() != need {
        out.clear();
        out.resize(need, 0);
    }
    let uv_off = dst_w * dst_h;
    // Letterbox first, in black (BT.601 limited range: luma floor 16, neutral chroma 128), so the
    // bars are already right wherever the image doesn't reach.
    out[..uv_off].fill(16);
    out[uv_off..].fill(128);

    let (fit_w, fit_h, off_x, off_y) = fit_rect(src_w, src_h, dst_w, dst_h);
    if fit_w == 0 || fit_h == 0 {
        return;
    }

    // The source's geometry is the caller's claim about someone else's buffer; a stale claim used
    // to walk off the end and panic, which kills a live share. A black frame is the honest answer.
    if bgra.len() < stride * src_h || stride < src_w * 4 {
        log::warn!("frame is {} bytes, but {src_w}x{src_h} stride {stride} needs {} — dropping it",
            bgra.len(), stride * src_h);
        return;
    }

    // No scaling and no bars: this is the plain conversion, and doing it the general way costs
    // five times as much for the same pixels.
    if (fit_w, fit_h, off_x, off_y) == (dst_w, dst_h, 0, 0) && (src_w, src_h) == (dst_w, dst_h) {
        bgra_to_nv12_into(bgra, dst_w, dst_h, stride, out);
        return;
    }

    // Source spans per destination column, computed once instead of per row: this loop runs
    // width*height times a frame, so anything left inside it is paid two million times over.
    let xs: Vec<(usize, usize)> = (0..fit_w)
        .map(|dx| {
            let sx0 = dx * src_w / fit_w;
            let sx1 = ((dx + 1) * src_w).div_ceil(fit_w).min(src_w).max(sx0 + 1);
            (sx0, sx1)
        })
        .collect();

    // Averaged BGR per destination pixel: straight into Y, and accumulated per 2x2 block for the
    // chroma pair so the source is read once, not twice.
    let cw = fit_w / 2;
    let mut chroma_acc: Vec<[u32; 3]> = vec![[0; 3]; cw.max(1)];

    for dy in 0..fit_h {
        let sy0 = dy * src_h / fit_h;
        let sy1 = ((dy + 1) * src_h).div_ceil(fit_h).min(src_h).max(sy0 + 1);
        if dy % 2 == 0 {
            chroma_acc.iter_mut().for_each(|c| *c = [0; 3]);
        }
        let y_row = (off_y + dy) * dst_w + off_x;

        for (dx, &(sx0, sx1)) in xs.iter().enumerate() {
            let (mut sb, mut sg, mut sr) = (0u32, 0u32, 0u32);
            let n = ((sx1 - sx0) * (sy1 - sy0)) as u32;
            for sy in sy0..sy1 {
                let row = sy * stride;
                for sx in sx0..sx1 {
                    let px = &bgra[row + sx * 4..row + sx * 4 + 3];
                    sb += px[0] as u32;
                    sg += px[1] as u32;
                    sr += px[2] as u32;
                }
            }
            let (b, g, r) = (sb / n, sg / n, sr / n);
            out[y_row + dx] = luma(b, g, r);

            let c = &mut chroma_acc[dx / 2];
            c[0] += b;
            c[1] += g;
            c[2] += r;
        }

        // Every second row completes a 2x2 block: one chroma pair per block.
        if dy % 2 == 1 && cw > 0 {
            let cy = (off_y + dy - 1) / 2;
            let at = uv_off + cy * dst_w + off_x;
            for (cx, c) in chroma_acc.iter().enumerate().take(cw) {
                let (u, v) = chroma(c[0] / 4, c[1] / 4, c[2] / 4);
                out[at + cx * 2] = u;
                out[at + cx * 2 + 1] = v;
            }
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

#[cfg(test)]
mod tests {
    use super::{bgra_to_nv12_fit_into, fit_rect, nv12_len};

    /// A solid-colour BGRA frame, tightly packed.
    fn solid(w: usize, h: usize, b: u8, g: u8, r: u8) -> Vec<u8> {
        (0..w * h).flat_map(|_| [b, g, r, 255]).collect()
    }

    /// Detailed, non-uniform content with a padded stride — the shape a real capture has. Solid
    /// colours cannot catch a position or stride mistake; every earlier test here used one.
    fn detailed(w: usize, h: usize, stride: usize) -> Vec<u8> {
        let mut v = vec![0u8; stride * h];
        for y in 0..h {
            for x in 0..w {
                let i = y * stride + x * 4;
                v[i] = (x * 7 + y * 3) as u8;        // b
                v[i + 1] = (x * 3 + y * 11) as u8;   // g
                v[i + 2] = (x * 13 + y * 5) as u8;   // r
                v[i + 3] = 255;
            }
        }
        v
    }

    /// At 1:1 the scaler averages a 1x1 box, so its luma must match the plain converter's exactly.
    /// Any disagreement is a position or stride bug — which is what a corrupted stream looks like.
    #[test]
    fn should_match_the_plain_converter_at_one_to_one() {
        let (w, h) = (64, 32);
        let stride = w * 4 + 64; // padded, like a real staging texture
        let src = detailed(w, h, stride);

        let mut plain = Vec::new();
        super::bgra_to_nv12_into(&src, w, h, stride, &mut plain);
        let mut fitted = Vec::new();
        bgra_to_nv12_fit_into(&src, w, h, stride, w, h, &mut fitted);

        assert_eq!(fitted.len(), plain.len());
        assert_eq!(&fitted[..w * h], &plain[..w * h], "luma must be identical at 1:1");
    }

    /// A downscale must still land the image where it belongs: brightness has to follow the source's
    /// gradient across the canvas, not shear or wrap.
    #[test]
    fn should_keep_the_image_oriented_when_downscaling() {
        let (w, h) = (64, 64);
        let stride = w * 4 + 32;
        // Left half black, right half white: the canvas must show the same split.
        let mut src = vec![0u8; stride * h];
        for y in 0..h {
            for x in (w / 2)..w {
                let i = y * stride + x * 4;
                src[i] = 255; src[i + 1] = 255; src[i + 2] = 255; src[i + 3] = 255;
            }
        }
        let mut out = Vec::new();
        bgra_to_nv12_fit_into(&src, w, h, stride, 32, 32, &mut out);

        let row = 16 * 32; // a middle row of the canvas
        assert!(out[row + 4] < 60, "left of the canvas must stay dark");
        assert!(out[row + 27] > 200, "right of the canvas must stay bright");
    }

    #[test]
    fn should_fill_the_canvas_when_the_aspects_match() {
        assert_eq!(fit_rect(1920, 1080, 1280, 720), (1280, 720, 0, 0));
        assert_eq!(fit_rect(2560, 1440, 1280, 720), (1280, 720, 0, 0));
    }

    #[test]
    fn should_letterbox_a_source_that_is_taller_than_the_canvas() {
        // 4:3 into 16:9 → full height, bars left and right.
        let (w, h, x, y) = fit_rect(800, 600, 1280, 720);
        assert_eq!((w, h), (960, 720));
        assert_eq!((x, y), (160, 0));
    }

    #[test]
    fn should_keep_the_fitted_rect_even_for_chroma_pairing() {
        let (w, h, x, y) = fit_rect(1001, 999, 640, 360);
        assert_eq!(w % 2, 0, "width must be even");
        assert_eq!(h % 2, 0, "height must be even");
        assert_eq!(x % 2, 0, "x offset must be even");
        assert_eq!(y % 2, 0, "y offset must be even");
    }

    #[test]
    fn should_scale_a_solid_source_to_the_same_solid_colour() {
        // Mid grey: box-averaging any block of it must give back the same luma.
        let src = solid(64, 64, 128, 128, 128);
        let mut out = Vec::new();
        bgra_to_nv12_fit_into(&src, 64, 64, 64 * 4, 32, 32, &mut out);
        assert_eq!(out.len(), nv12_len(32, 32));

        let expected_y = (0.257 * 128.0 + 0.504 * 128.0 + 0.098 * 128.0 + 16.0) as u8;
        assert!(
            out[..32 * 32].iter().all(|&y| (y as i16 - expected_y as i16).abs() <= 1),
            "luma should survive the downscale"
        );
        // Grey is neutral: chroma sits at 128.
        assert!(out[32 * 32..].iter().all(|&c| (c as i16 - 128).abs() <= 1));
    }

    /// The live crash: the source resized 2560x1392 -> 1692x905 mid-share, the frame arrived at
    /// the new size, and the caller still described it with the old one — walking off the end.
    #[test]
    fn should_drop_a_frame_smaller_than_its_claimed_geometry_instead_of_panicking() {
        let frame = solid(1692, 905, 10, 20, 30);
        let mut out = Vec::new();
        bgra_to_nv12_fit_into(&frame, 2560, 1392, 2560 * 4, 1280, 720, &mut out);
        assert_eq!(out.len(), nv12_len(1280, 720), "canvas is still well-formed");
        assert!(out[..1280 * 720].iter().all(|&y| y == 16), "and black, not garbage");
    }

    /// Same shape, the way it actually reaches us: geometry from the frame, so it just works.
    #[test]
    fn should_scale_a_resized_source_into_the_unchanged_canvas() {
        let mut out = Vec::new();
        let before = solid(2560, 1392, 255, 255, 255);
        bgra_to_nv12_fit_into(&before, 2560, 1392, 2560 * 4, 1280, 720, &mut out);
        assert_eq!(out.len(), nv12_len(1280, 720));

        let after = solid(1692, 905, 255, 255, 255);
        bgra_to_nv12_fit_into(&after, 1692, 905, 1692 * 4, 1280, 720, &mut out);
        assert_eq!(out.len(), nv12_len(1280, 720), "the canvas never changes size");
        assert!(out[..1280 * 720].iter().any(|&y| y > 200), "the image is still drawn");
    }

    #[test]
    fn should_paint_black_bars_where_the_image_does_not_reach() {
        // 2:1 source into a square canvas → bars top and bottom.
        let src = solid(64, 32, 255, 255, 255);
        let mut out = Vec::new();
        bgra_to_nv12_fit_into(&src, 64, 32, 64 * 4, 32, 32, &mut out);

        let (_, fit_h, _, off_y) = fit_rect(64, 32, 32, 32);
        assert!(off_y > 0 && fit_h < 32, "this case must letterbox");
        // Top bar is black...
        assert!(out[..off_y * 32].iter().all(|&y| y == 16), "top bar must be black");
        // ...and the image itself is not.
        assert!(out[off_y * 32] > 200, "the image must be white");
    }
}
