/**
 * helperProbe.ts — reads what the game-capture helper answers to a `--probe-*` flag.
 *
 * The helper prints one JSON object as its last stdout line. Anything else — an older helper that
 * does not know the flag, a crash, a log line where the answer should be — reads as "could not
 * tell" (null), and every caller treats null as "behave as before".
 */

export type ProbeAnswer = Record<string, unknown>;

/** The slice of a ChildProcess a probe needs — a real spawn in the app, a fake in tests. */
export type ProbeChild = {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): unknown } | null;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  kill(): unknown;
};

/**
 * Runs a probe and resolves its answer, or null if it gave none within `timeoutMs`.
 *
 * Read on `close`, not `exit`: `exit` can fire while the last of stdout is still in the pipe, and the
 * helper prints its answer and exits at once — reading on `exit` could miss the one line that matters.
 */
export function runProbe(spawnChild: () => ProbeChild, timeoutMs: number): Promise<ProbeAnswer | null> {
  return new Promise((resolve) => {
    let child: ProbeChild;
    try {
      child = spawnChild();
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseProbeAnswer(out));
    });
  });
}

export function parseProbeAnswer(stdout: string): ProbeAnswer | null {
  const lines = stdout.trim().split(/\r?\n/);
  try {
    const answer: unknown = JSON.parse(lines[lines.length - 1]);
    return typeof answer === "object" && answer !== null && !Array.isArray(answer)
      ? (answer as ProbeAnswer)
      : null;
  } catch {
    return null;
  }
}

/** `--probe-encoders`: whether either codec has a working hardware encoder. */
export function smoothSupportFrom(answer: ProbeAnswer | null): boolean | null {
  if (!answer) return null;
  return answer.h264 === true || answer.h265 === true;
}

/** `--probe-hdr`: whether any monitor is in HDR. */
export function hdrActiveFrom(answer: ProbeAnswer | null): boolean | null {
  return typeof answer?.hdr === "boolean" ? answer.hdr : null;
}
