import { describe, it, expect } from "vitest";
import { createOutputTracker } from "./helperOutput";

// A fallback report that says "helper exited (code 1)" names the messenger, not the cause — and
// the cause was on the stream a moment before. This is the piece that keeps it. It shipped once
// without doing so and the first real report in production was unactionable.
//
// Pushes here end in "\n" on purpose: that is what a real chunk looks like, and the tracker
// reassembles lines rather than assuming one push is one line.

const STATS_MSG = "encode: fed 30.0 fps, sent 30.0 fps";
const STATS = `[2026-08-14T10:11:44Z INFO  mqvi_game_capture] ${STATS_MSG}\n`;
const READY = "[2026-08-14T10:11:43Z INFO  mqvi_game_capture] MQVI-READY\n";
// No log prefix: this is the Rust runtime printing what `main` returned, not env_logger.
const FAILURE = "Error: no hardware encoder MFT available for this codec\n";

describe("createOutputTracker", () => {
  it("should say nothing when the helper said nothing", () => {
    expect(createOutputTracker().said()).toBe("");
  });

  it("should report the only line it saw", () => {
    const t = createOutputTracker();
    t.push(FAILURE);

    expect(t.said()).toBe(FAILURE.trim());
  });

  // The whole reason for preferring an error over the most recent line: the helper narrates once a
  // second, so a stats line lands between the failure and the exit and would otherwise win.
  it("should keep the error even when a later line follows it", () => {
    const t = createOutputTracker();
    t.push(FAILURE);
    t.push(STATS);

    expect(t.said()).toBe(FAILURE.trim());
  });

  it("should fall back to the last line when nothing looks like an error", () => {
    const t = createOutputTracker();
    t.push(READY);
    t.push(STATS);

    expect(t.said()).toBe(STATS_MSG);
  });

  it("should keep every distinct error, oldest first", () => {
    const t = createOutputTracker();
    t.push("Error: first\n");
    t.push("Error: second\n");

    expect(t.said()).toBe("Error: first | Error: second");
  });

  it("should replace an error with a fuller wording of the same one", () => {
    const t = createOutputTracker();
    t.push("Error: SetOutputType\n");
    t.push("Error: SetOutputType: not supported for D3D device\n");

    expect(t.said()).toBe("Error: SetOutputType: not supported for D3D device");
  });

  it("should split a multi-line chunk", () => {
    const t = createOutputTracker();
    t.push(`${READY}${FAILURE}${STATS}`);

    expect(t.said()).toBe(FAILURE.trim());
  });

  // Deliberately with no error line in play: with one, `said()` returns it whatever happened to
  // the last-line slot, and the test would pass without the blank ever being rejected.
  it("should ignore blank lines rather than reporting one", () => {
    const t = createOutputTracker();
    t.push(STATS);
    t.push("\n   \n");

    expect(t.said()).toBe(STATS_MSG);
  });

  it("should recognise a panic as a failure", () => {
    const t = createOutputTracker();
    t.push("thread 'main' panicked at src/main.rs:12\n");
    t.push(STATS);

    expect(t.said()).toContain("panicked");
  });

  // The trap in stripping the prefix: `log::error!("encoder stopped: …")` writes nothing that reads
  // as a failure, and the ERROR that says it is one lives in the prefix being removed. Detection
  // therefore runs on the full line and only the stored text is trimmed.
  it("should detect a failure by its ERROR level and store it without the log prefix", () => {
    const t = createOutputTracker();
    t.push("[2026-08-14T10:11:45Z ERROR mqvi_game_capture] encoder stopped: NoFrames\n");
    t.push(STATS);

    expect(t.said()).toBe("encoder stopped: NoFrames");
  });

  // `fn main() -> Result<()>` prints the anyhow chain over several indented lines. Keeping only one
  // of them reports an inner cause as if it were the whole failure — "0: transport error" without
  // the message that says what was being attempted.
  it("should fold an anyhow cause chain onto the message it belongs to", () => {
    const t = createOutputTracker();
    t.push("Error: LiveKit connect failed\n\nCaused by:\n    0: transport error\n    1: refused\n");

    expect(t.said()).toBe("Error: LiveKit connect failed; 0: transport error; 1: refused");
  });

  it("should not attach an indented line to an error a normal line has already ended", () => {
    const t = createOutputTracker();
    t.push(FAILURE);
    t.push(STATS);
    t.push("    stray indented line\n");

    expect(t.said()).toBe(FAILURE.trim());
  });

  // Rust's stderr is unbuffered and anyhow's Debug impl writes in fragments, so the pipe can hand
  // Electron half a line. Treating each chunk as a line would report that half.
  it("should reassemble a line split across chunks", () => {
    const t = createOutputTracker();
    t.push("Error: no hardware enc");
    t.push("oder MFT available\n");

    expect(t.said()).toBe("Error: no hardware encoder MFT available");
  });

  it("should report a final line that never got its newline", () => {
    const t = createOutputTracker();
    t.push(STATS);
    t.push("Error: died before flushing");

    expect(t.said()).toBe("Error: died before flushing");
  });

  // The whole failure, end to end, from output measured by running the real helper: its encoder
  // was pointed at a resolution the MFT rejects, and `probe-encoders` supplied the inventory
  // through the same function the helper calls. v2.23.1 reported this as "the hardware encoder
  // produced no frames" — the symptom, with the fault and the machine's capability both lost.
  const CAUSE = "SetOutputType: The input type is not supported for D3D device. (0xC00D6D76)";
  const INVENTORY = "h264: NVIDIA H.264 Encoder MFT; h265: NVIDIA HEVC Encoder MFT";

  it("should report the fault and the machine's encoders as one line the server keeps whole", () => {
    const t = createOutputTracker();
    t.push(`[2026-08-14T16:33:10Z ERROR mqvi_game_capture] ${CAUSE}\n`);
    t.push("[2026-08-14T16:33:10Z INFO  mqvi_game_capture] shutdown: signalling pump\n");
    t.push("[2026-08-14T16:33:10Z INFO  mqvi_game_capture] shutdown: joining encode thread\n");
    t.push("[2026-08-14T16:33:10Z INFO  mqvi_game_capture] shutdown: done\n");
    t.push(`Error: ${CAUSE} (no frames produced; ${INVENTORY})\n`);

    // Folded into one entry, not two: the helper's final error opens with the same text the pump
    // logged, so the budget is spent on the inventory rather than on saying the cause twice.
    expect(t.said()).toBe(`Error: ${CAUSE} (no frames produced; ${INVENTORY})`);
    // The server truncates `detail` at 200 characters. Nothing here may depend on being kept.
    expect(t.said().length).toBeLessThanOrEqual(200);
  });

  it("should bound a very deep cause chain", () => {
    const t = createOutputTracker();
    t.push("Error: top\n");
    for (let i = 0; i < 40; i++) t.push(`    ${i}: a cause long enough to matter here\n`);

    expect(t.said()).toContain("Error: top");
    expect(t.said().length).toBeLessThan(400);
  });
});
