/**
 * Watches one voice join: if the room is not connected to the voice server (LiveKit) once the
 * timeout runs out, the attempt is reported with the last error it saw. The app swallows LiveKit
 * connection errors on purpose (the first connect of every join is aborted by LiveKitRoom itself,
 * which rebuilds its Room when the options arrive), so without this a join that never connects
 * leaves no trace anywhere.
 */

/** LiveKit's own signal and peer-connection timeouts are 15 s; its errors arrive before this. */
export const VOICE_CONNECT_TIMEOUT_MS = 15_000;

export const VOICE_CONNECT_FAILURE = "voice: no connection to the voice server after 15s";

/** What every join aborts on its own; never the reason a join failed. */
const ROUTINE_ABORT = /client initiated disconnect|abort connection attempt/i;

export interface VoiceConnectWatch {
  /** The room reached the voice server: nothing to report. */
  connected: () => void;
  /** An error from the attempt, kept for the report. */
  failed: (err: Error) => void;
  /** The user left, or the attempt was replaced: nothing to report. */
  cancel: () => void;
}

export interface VoiceConnectWatchOptions {
  /** Whether the room is connected right now, whatever token it holds. */
  isRoomConnected: () => boolean;
  /** Called once, with the details, when the attempt failed. */
  report: (detail: string) => void;
  /** Context for the report: the voice server's host and whether E2EE is on. */
  context: () => { serverUrl: string | null; e2ee: boolean; online: boolean };
  timeoutMs?: number;
}

export function watchVoiceConnect(opts: VoiceConnectWatchOptions): VoiceConnectWatch {
  let done = false;
  let lastError: string | null = null;

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    // A token swapped while connected does not connect again (LiveKit's connect is a no-op then).
    if (opts.isRoomConnected()) return;
    const { serverUrl, e2ee, online } = opts.context();
    // The second line is what the client and the server dedupe on, so a different error is a new report.
    opts.report(
      [
        `server: ${hostOf(serverUrl)}`,
        `last error: ${lastError ?? "none"}`,
        `online: ${online}`,
        `e2ee: ${e2ee}`,
      ].join("\n")
    );
  }, opts.timeoutMs ?? VOICE_CONNECT_TIMEOUT_MS);

  const stop = () => {
    done = true;
    clearTimeout(timer);
  };

  return {
    connected: stop,
    failed: (err) => {
      const text = `${err.name}: ${err.message}`;
      if (!done && !ROUTINE_ABORT.test(text)) lastError = text;
    },
    cancel: stop,
  };
}

function hostOf(url: string | null): string {
  if (!url) return "none";
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}
