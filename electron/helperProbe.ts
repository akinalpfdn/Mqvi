/**
 * helperProbe.ts — reads what the game-capture helper answers to a `--probe-*` flag.
 *
 * The helper prints one JSON object as its last stdout line. Anything else — an older helper that
 * does not know the flag, a crash, a log line where the answer should be — reads as "could not
 * tell" (null), and every caller treats null as "behave as before".
 */

export type ProbeAnswer = Record<string, unknown>;

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
