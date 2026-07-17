//! test-encode — drives the MF hardware encoder on synthetic NV12 frames, no LiveKit.
//!
//! Local de-risk for NGC-02: proves the vendor-agnostic hardware MFT actually produces valid
//! H264. Producing output from the "NVIDIA/AMD/Intel ... Encoder MFT" means the GPU encoded it.
//! Writes an Annex-B stream to the temp dir for sanity inspection.

use anyhow::Result;
use mqvi_game_capture::{mf_encoder::HwEncoder, nv12};

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // Width matters: an MFT reads our tightly-packed NV12 with the stride it decided on, so a
    // width it wants to align differently comes out sheared. Pass one to compare.
    let arg = |name: &str, default: u32| -> u32 {
        std::env::args()
            .position(|a| a == name)
            .and_then(|i| std::env::args().nth(i + 1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let (w, h, fps) = (arg("--width", 1280), arg("--height", 720), 30u32);
    let hevc = std::env::args().any(|a| a == "--hevc");
    println!("encoding {w}x{h} (width % 16 = {})", w % 16);

    HwEncoder::startup()?;
    let mut enc = HwEncoder::new(w, h, fps, 4_000_000, hevc)?;
    println!("encoder MFT: {}", enc.name());

    let frame_us = 1_000_000i64 / fps as i64;
    let mut stream = Vec::new();
    let (mut packets, mut keyframes) = (0u32, 0u32);
    let mut timestamps = Vec::new();

    for i in 0..120u64 {
        let frame = nv12::test_pattern(w as usize, h as usize, i);
        for p in enc.encode(&frame, i as i64 * frame_us, frame_us, false)? {
            packets += 1;
            if p.keyframe {
                keyframes += 1;
            }
            if timestamps.len() < 8 {
                timestamps.push(p.timestamp_us);
            }
            stream.extend_from_slice(&p.data);
        }
    }
    println!("first packet timestamps (µs, expect steps of {frame_us}): {timestamps:?}");

    let out = std::env::temp_dir().join(format!("mqvi_test_{w}x{h}.{}", if hevc { "h265" } else { "h264" }));
    std::fs::write(&out, &stream)?;

    println!(
        "done: {packets} packets, {keyframes} keyframes, {} bytes → {}",
        stream.len(),
        out.display()
    );
    println!("first 8 bytes (expect Annex-B start code 00 00 00 01): {:02x?}", &stream[..stream.len().min(8)]);
    if !hevc {
        analyze_slice_types(&stream);
    }
    if packets == 0 {
        anyhow::bail!("encoder produced no packets");
    }
    Ok(())
}

/// Prints the distinct H264 slice types in the stream — proves whether B-frames (which cause
/// reorder ghosting over WebRTC) are present. 0/5=P, 1/6=B, 2/7=I.
fn analyze_slice_types(stream: &[u8]) {
    let mut counts = [0u32; 3]; // [P, B, I]
    let mut i = 0;
    while i + 4 < stream.len() {
        let (sc, nal_off) = if stream[i..i + 3] == [0, 0, 1] {
            (true, i + 3)
        } else if i + 4 <= stream.len() && stream[i..i + 4] == [0, 0, 0, 1] {
            (true, i + 4)
        } else {
            (false, 0)
        };
        if !sc {
            i += 1;
            continue;
        }
        let nal_type = stream[nal_off] & 0x1F;
        if nal_type == 1 || nal_type == 5 {
            // strip emulation-prevention in the first few RBSP bytes, then read 2 ue(v)
            let rbsp: Vec<u8> = stream[nal_off + 1..(nal_off + 8).min(stream.len())].to_vec();
            let mut br = BitReader { data: &rbsp, bit: 0 };
            let _first_mb = br.ue();
            let st = br.ue();
            match st % 5 {
                0 => counts[0] += 1,
                1 => counts[1] += 1,
                2 => counts[2] += 1,
                _ => {}
            }
        }
        i = nal_off + 1;
    }
    println!("slice types → P: {}  B: {}  I: {}", counts[0], counts[1], counts[2]);
    if counts[1] > 0 {
        println!("  ⚠ B-frames present — reorder ghosting expected over WebRTC");
    } else {
        println!("  ✓ no B-frames (P/I only) — no reorder ghosting from the encoder");
    }
}

struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}
impl BitReader<'_> {
    fn bit(&mut self) -> u32 {
        if self.bit >= self.data.len() * 8 {
            return 1; // avoid runaway; treat as terminator
        }
        let b = (self.data[self.bit / 8] >> (7 - self.bit % 8)) & 1;
        self.bit += 1;
        b as u32
    }
    fn ue(&mut self) -> u32 {
        let mut zeros = 0;
        while self.bit() == 0 {
            zeros += 1;
            if zeros > 31 {
                return 0;
            }
        }
        let mut val = 0u32;
        for _ in 0..zeros {
            val = (val << 1) | self.bit();
        }
        (1u32 << zeros) - 1 + val
    }
}
