/**
 * Whether a share that failed to start is a failure worth reporting, or the user backing out.
 *
 * - Desktop app: the picker clears the picked source on cancel before getDisplayMedia rejects, so a
 *   source still set means something was chosen and then failed.
 * - Web: the browser's own picker rejects with NotAllowedError when it is dismissed (or permission
 *   is refused); every other error — NotReadableError, a capture the OS would not give — is real.
 * - Mobile: the native plugin rejects with code PERMISSION_DENIED when the user declines the
 *   system's screen-capture prompt (Android's MediaProjection); anything else is real.
 */
export function isStartFailureWorthReporting(opts: {
  platform: "electron" | "web" | "mobile";
  pickedShareSourceId: string | null;
  err: unknown;
}): boolean {
  switch (opts.platform) {
    case "electron":
      return opts.pickedShareSourceId !== null;
    case "web":
      return !(opts.err instanceof Error && opts.err.name === "NotAllowedError");
    case "mobile":
      return !(typeof opts.err === "object" && opts.err !== null && "code" in opts.err && opts.err.code === "PERMISSION_DENIED");
  }
}
