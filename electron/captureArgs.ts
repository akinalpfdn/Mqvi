/**
 * captureArgs.ts — the engine flags handed to the game-capture helper.
 *
 * The values come from the renderer over IPC, so they are checked here rather than trusted: an
 * engine the helper does not know makes it exit with a usage error, and the bitrate becomes a
 * publish ceiling.
 */

export type CaptureEngine = "smooth" | "sharp";

/** Bounds for the sharp bitrate: wider than any setting the app offers, so only nonsense is refused. */
const MIN_BITRATE = 100_000;
const MAX_BITRATE = 20_000_000;

/**
 * `--engine`/`--max-bitrate` for a share, or null when the request is malformed. Smooth passes
 * nothing: the helper's default is smooth, which keeps the command line of today's shares unchanged.
 */
export function engineArgs(engine: unknown, maxBitrate: unknown): string[] | null {
  if (engine === undefined || engine === "smooth") return [];
  if (engine !== "sharp") return null;
  if (maxBitrate === undefined) return ["--engine", "sharp"];
  if (
    typeof maxBitrate !== "number" ||
    !Number.isInteger(maxBitrate) ||
    maxBitrate < MIN_BITRATE ||
    maxBitrate > MAX_BITRATE
  ) {
    return null;
  }
  return ["--engine", "sharp", "--max-bitrate", String(maxBitrate)];
}
