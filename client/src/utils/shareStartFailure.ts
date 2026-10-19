/**
 * Whether a share that failed to start is a failure worth reporting, or the user backing out.
 *
 * In the desktop app the picker clears the picked source on cancel before getDisplayMedia rejects,
 * so a source still set means something was chosen and then failed. On the web there is no picker
 * of ours: the browser's own rejects with NotAllowedError when it is dismissed (or permission is
 * refused), and every other error — NotReadableError, a capture the OS would not give — is real.
 */
export function isStartFailureWorthReporting(opts: {
  isElectronApp: boolean;
  pickedShareSourceId: string | null;
  err: unknown;
}): boolean {
  if (opts.isElectronApp) return opts.pickedShareSourceId !== null;
  return !(opts.err instanceof Error && opts.err.name === "NotAllowedError");
}
