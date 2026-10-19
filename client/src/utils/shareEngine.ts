/**
 * shareEngine.ts — which engine carries a screen share.
 *
 * Two modes, three engines. "Smooth Video" is always the native helper (hardware H264/H265).
 * "Sharp Video" is the browser's getDisplayMedia + VP9 — except on an HDR display, where Chromium
 * captures 8-bit and clips HDR content, so the helper takes it instead: the same tone-mapped
 * capture as smooth, fed to libwebrtc's software VP9 with the browser engine's own settings.
 */

import type { ScreenShareMode, ScreenShareQuality } from "../stores/slices/voiceSettingsSlice";

/** A helper engine, as the server's fallback report names it. */
export type NativeEngine = "smooth" | "sharp_hdr";
export type ShareEngine = NativeEngine | "browser";

/**
 * The helper's exit code when the source it was capturing went away — the window closed, the game
 * exited. The user's doing, like a browser share whose source closes, so it is not shown as an
 * error. Kept in step with `SOURCE_GONE_EXIT` in native/game-capture/src/main.rs.
 */
export const HELPER_EXIT_SOURCE_GONE = 3;

/** "Sharp Video"'s encoding. The browser publishes with it; the helper's sharp engine copies it. */
export function sharpShareEncoding(quality: ScreenShareQuality): { maxBitrate: number; maxFramerate: number } {
  return { maxBitrate: quality === "720p" ? 1_500_000 : 3_000_000, maxFramerate: 30 };
}

export function chooseShareEngine(opts: {
  mode: ScreenShareMode;
  /** From the encoder probe; null = could not tell, so smooth is still tried. */
  smoothSupported: boolean | null;
  /** From the HDR probe; null = could not tell, so the browser keeps sharp as before. */
  hdrActive: boolean | null;
  /** The helper exists only in the Windows desktop app. */
  hasHelper: boolean;
}): ShareEngine {
  if (!opts.hasHelper) return "browser";
  if (opts.mode === "smooth" && opts.smoothSupported !== false) return "smooth";
  return opts.hdrActive === true ? "sharp_hdr" : "browser";
}

/**
 * `chooseShareEngine`, asking about HDR only when the answer can change the result: a smooth share
 * tone-maps on its own, so it never waits on the probe.
 */
export async function resolveShareEngine(opts: {
  mode: ScreenShareMode;
  smoothSupported: boolean | null;
  hasHelper: boolean;
  askHdr: () => Promise<boolean | null>;
}): Promise<ShareEngine> {
  const { askHdr, ...rest } = opts;
  const withoutHdr = chooseShareEngine({ ...rest, hdrActive: null });
  if (withoutHdr !== "browser" || !rest.hasHelper) return withoutHdr;
  const hdrActive = await askHdr().catch(() => null);
  return chooseShareEngine({ ...rest, hdrActive });
}
