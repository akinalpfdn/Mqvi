/**
 * One run of a share's audio: start the capture, publish its track, take both down again.
 * VoiceStateManager's share-audio effect starts one per pass and cancels it in its cleanup. Apart
 * from the component so its races can be tested: a run cancelled or ended mid-start, a capture
 * that ends on its own mid-share, a start that fails.
 */
import type { ShareAudioStartResult } from "../hooks/useSystemAudioCapture";

/** What the user is told, as a `voice` translation key. */
export type ShareAudioNotice = "shareAudioStopped" | "shareAudioFailed";

export interface ShareAudioRunDeps<Published> {
  /** Starts the capture. `onEnded` fires if it ends on its own after its track came back. */
  start: (onEnded: () => void) => Promise<ShareAudioStartResult>;
  /** Stops the one capture process behind the hook. */
  stopCapture: () => void;
  publish: (track: MediaStreamTrack) => Promise<Published>;
  unpublish: (published: Published) => Promise<void>;
  /** Whether this run still owns the capture. A run cancelled mid-start finishes after the next
   *  one has started its own; stopping then would kill the live capture. */
  isCurrentOwner: () => boolean;
  notify: (notice: ShareAudioNotice) => void;
  logError: (what: string, err: unknown) => void;
}

/** How long a share whose audio capture ended must stay on before the user is told. A closed window
 *  ends its audio and its video together, and the video side can take about a second to see it. */
export const SHARE_AUDIO_END_GRACE_MS = 2_000;

export function startShareAudioRun<Published>(deps: ShareAudioRunDeps<Published>): { cancel: () => void } {
  let cancelled = false;
  let endedByCapture = false;
  let published: Published | null = null;
  let endedNotice: ReturnType<typeof setTimeout> | null = null;

  async function takeDown() {
    const pub = published;
    published = null;
    if (deps.isCurrentOwner()) deps.stopCapture();
    if (pub !== null) await deps.unpublish(pub);
  }

  // The capture ended on its own mid-share. The track comes off at once: left published, it stays
  // on silent and the user believes viewers still hear the share. A share that ends within the
  // grace needs no "audio stopped".
  function handleEnded() {
    if (cancelled || !deps.isCurrentOwner()) return;
    endedByCapture = true;
    takeDown().catch((err: unknown) => deps.logError("Removing ended screen share audio failed:", err));
    endedNotice = setTimeout(() => {
      if (!cancelled) deps.notify("shareAudioStopped");
    }, SHARE_AUDIO_END_GRACE_MS);
  }

  async function run() {
    const started = await deps.start(handleEnded);
    if (started.status !== "started") {
      // A capture that missed its header may still be recording; nothing else would stop it
      // before the share ends.
      if (deps.isCurrentOwner()) deps.stopCapture();
      if (started.status === "failed" && !cancelled) deps.notify("shareAudioFailed");
      return;
    }
    if (cancelled || endedByCapture) {
      if (deps.isCurrentOwner()) deps.stopCapture();
      return;
    }
    const pub = await deps.publish(started.track);
    if (cancelled || endedByCapture) {
      // Stopped or ended mid-publish: takeDown() saw no publication yet, so this one would
      // outlive the share as a dead track nobody unpublishes.
      await deps.unpublish(pub);
      if (deps.isCurrentOwner()) deps.stopCapture();
      return;
    }
    published = pub;
  }

  run().catch((err: unknown) => deps.logError("Screen share audio failed:", err));

  return {
    cancel() {
      cancelled = true;
      if (endedNotice) clearTimeout(endedNotice);
      takeDown().catch((err: unknown) => deps.logError("Stopping screen share audio failed:", err));
    },
  };
}
