import { EventEmitter } from "events";
import { describe, it, expect, vi, afterEach } from "vitest";
import { hdrActiveFrom, parseProbeAnswer, runProbe, smoothSupportFrom, type ProbeChild } from "./helperProbe";

// The helper's answer decides what the share picker offers and warns about. A misread answer either
// hides "Smooth Video" from a machine that can run it or warns about HDR that is not there, so
// everything that is not a clean answer must come out as "could not tell".

const LOG = "[2026-10-19T12:16:33Z INFO  mqvi_game_capture::mf_encoder] encoder cfg cbr: ok";

describe("parseProbeAnswer", () => {
  it("should read the answer from the last line after log output", () => {
    expect(parseProbeAnswer(`${LOG}\n${LOG}\n{"hdr":true}\n`)).toEqual({ hdr: true });
  });

  it("should read an answer printed with CRLF", () => {
    expect(parseProbeAnswer(`${LOG}\r\n{"h264":true,"h265":false}\r\n`)).toEqual({ h264: true, h265: false });
  });

  it("should return null when the helper printed nothing, as an older one does for an unknown flag", () => {
    expect(parseProbeAnswer("")).toBeNull();
  });

  it("should return null when the last line is not JSON", () => {
    expect(parseProbeAnswer(`{"hdr":true}\n${LOG}`)).toBeNull();
  });

  it.each(["null", "[true]", "true", '"hdr"'])("should return null for JSON that is not an object: %s", (line) => {
    expect(parseProbeAnswer(line)).toBeNull();
  });
});

describe("smoothSupportFrom", () => {
  it("should be true when either codec works", () => {
    expect(smoothSupportFrom({ h264: false, h265: true })).toBe(true);
  });

  it("should be false when neither works", () => {
    expect(smoothSupportFrom({ h264: false, h265: false })).toBe(false);
  });

  it("should not count a truthy non-boolean as support", () => {
    expect(smoothSupportFrom({ h264: "none" })).toBe(false);
  });

  it("should be null without an answer", () => {
    expect(smoothSupportFrom(null)).toBeNull();
  });
});

describe("hdrActiveFrom", () => {
  it.each([true, false])("should pass a boolean answer through: %s", (hdr) => {
    expect(hdrActiveFrom({ hdr })).toBe(hdr);
  });

  it("should be null when the helper could not ask the displays", () => {
    expect(hdrActiveFrom({ hdr: null })).toBeNull();
  });

  it("should be null when the answer is about something else", () => {
    expect(hdrActiveFrom({ h264: true })).toBeNull();
  });
});

/** A child process that does what it is told, in the order a test chooses. */
function fakeChild() {
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const kill = vi.fn();
  const child = {
    stdout: { on: (e: "data", cb: (chunk: Buffer) => void) => stdout.on(e, cb) },
    on: (e: string, cb: (...args: unknown[]) => void) => events.on(e, cb),
    kill,
  } as unknown as ProbeChild;
  return {
    child,
    kill,
    say: (text: string) => stdout.emit("data", Buffer.from(text)),
    emit: (event: "exit" | "close" | "error", arg?: unknown) => events.emit(event, arg),
  };
}

describe("runProbe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The race this exists for: the helper prints its answer and exits at once, and `exit` can be
  // delivered before the last stdout chunk. Reading there turned a real answer into null.
  it("should read an answer that arrives after the process has exited", async () => {
    const f = fakeChild();
    const answer = runProbe(() => f.child, 3_000);
    f.emit("exit", 0);
    f.say('{"hdr":true}\n');
    f.emit("close");
    expect(await answer).toEqual({ hdr: true });
  });

  it("should put together an answer split across chunks", async () => {
    const f = fakeChild();
    const answer = runProbe(() => f.child, 3_000);
    f.say('{"h264":tr');
    f.say('ue,"h265":false}\n');
    f.emit("close");
    expect(await answer).toEqual({ h264: true, h265: false });
  });

  it("should give up, and stop the process, when it does not answer in time", async () => {
    vi.useFakeTimers();
    const f = fakeChild();
    const answer = runProbe(() => f.child, 3_000);
    vi.advanceTimersByTime(3_000);
    expect(await answer).toBeNull();
    expect(f.kill).toHaveBeenCalled();
  });

  it("should be null when the process could not start", async () => {
    const f = fakeChild();
    const answer = runProbe(() => f.child, 3_000);
    f.emit("error", new Error("ENOENT"));
    expect(await answer).toBeNull();
  });

  it("should be null when spawning throws", async () => {
    const answer = runProbe(() => {
      throw new Error("EACCES");
    }, 3_000);
    expect(await answer).toBeNull();
  });
});
