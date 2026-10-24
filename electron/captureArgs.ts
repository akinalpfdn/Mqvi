/**
 * captureArgs.ts — the engine flags handed to the game-capture helper.
 *
 * The values come from the renderer over IPC, so they are checked here rather than trusted: an
 * engine the helper does not know makes it exit with a usage error, and the bitrate becomes a
 * publish ceiling.
 */

export type CaptureEngine = "smooth" | "sharp";

/** The platforms that ship the helper: Windows (WGC + Media Foundation) and macOS (ScreenCaptureKit + VideoToolbox). */
export function hasCaptureHelper(platform: string): boolean {
  return platform === "win32" || platform === "darwin";
}

/** The major number of a macOS version string ("14.5.0" → 14); 0 when it cannot be read. */
export function macMajor(version: string): number {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

/**
 * Whether "Smooth Video" can run here. Windows: yes, and the encoder probe has the final say. macOS:
 * from 14, because the helper sizes its capture with SCShareableContentInfo, which 13 lacks (there
 * the helper fails and every share would fall back with a warning). Linux: no helper.
 */
export function smoothCaptureOffered(platform: string, osVersion: string): boolean {
  if (platform === "darwin") return macMajor(osVersion) >= 14;
  return platform === "win32";
}

/**
 * Whether a share's audio can be captured here: Windows (audio-capture.exe) and macOS from 13
 * (ScreenCaptureKit audio). Elsewhere the "share audio" switch would promise sound that never goes.
 */
export function shareAudioSupported(platform: string, osVersion: string): boolean {
  if (platform === "darwin") return macMajor(osVersion) >= 13;
  return platform === "win32";
}

/** The helper binary's file name: an .exe on Windows, a plain executable on macOS. */
export function captureHelperName(platform: string): string {
  return platform === "win32" ? "mqvi-game-capture.exe" : "mqvi-game-capture";
}

/**
 * macOS: the helper's target for a picked desktopCapturer source. A screen is "screen:<id>:<n>"
 * with the display's CGDirectDisplayID, a window "window:<id>:<n>" with its CGWindowID; the helper
 * matches either exactly in ScreenCaptureKit. Anything else throws, and the share falls back to the
 * browser rather than capturing something other than what was picked.
 */
export function macCaptureTarget(sourceId: string | undefined): string[] {
  const m = /^(screen|window):(\d+):\d+$/.exec(sourceId ?? "");
  if (!m) throw new Error(`cannot capture source '${sourceId ?? ""}' on macOS`);
  return [m[1] === "screen" ? "--display-id" : "--window-id", m[2]];
}

/**
 * macOS: the helper's arguments for a share's audio. A window sends only its application's sound, a
 * screen (or a source we cannot address) everything except mqvi, whose processes the helper finds
 * from `selfPid`, the app's main process.
 */
export function macAudioArgs(sourceId: string | null | undefined, selfPid: number): string[] {
  let target: string[] = [];
  try {
    target = macCaptureTarget(sourceId ?? undefined);
  } catch {
    // No exact source: everything but mqvi, as Windows does for a monitor share.
  }
  return ["--audio-capture", ...target, "--self-pid", String(selfPid)];
}

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
