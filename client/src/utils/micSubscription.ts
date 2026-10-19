import { Track } from "livekit-client";

type MicState = {
  isDeafened: boolean;
  isServerDeafened: boolean;
  masterVolume: number;
  userVolumes: Record<string, number>;
};

/**
 * Whether to receive a participant's mic at all.
 *
 * Deafen and a volume of 0 — local mute is one — refuse the subscription instead of playing it at
 * 0: a freshly subscribed track starts on a new gain node at full volume, and livekit-client never
 * carries a stored volume of 0 over to it (it tests `if (this.elementVolume)`), so the 0 only lands
 * on a later setVolume and then fades in over ~0.3s. That was a second of a muted person's voice on
 * every join.
 */
export function shouldReceiveMic(state: MicState, identity: string): boolean {
  return (
    !state.isDeafened &&
    !state.isServerDeafened &&
    state.masterVolume > 0 &&
    (state.userVolumes[identity] ?? 100) > 0
  );
}

/** The slice of a remote participant this needs — real LiveKit objects in the app, fakes in tests. */
type ParticipantLike = {
  identity: string;
  trackPublications: { forEach(cb: (pub: { source: Track.Source; setSubscribed(on: boolean): void }) => void): void };
};

/** Subscribes every participant's mic that should be heard and drops every one that should not. */
export function applyMicSubscriptions(participants: Iterable<ParticipantLike>, state: MicState): void {
  for (const participant of participants) {
    const receive = shouldReceiveMic(state, participant.identity);
    participant.trackPublications.forEach((pub) => {
      if (pub.source === Track.Source.Microphone) pub.setSubscribed(receive);
    });
  }
}

/**
 * Who is silenced, as a stable string — what the subscription sync re-runs on. Every setSubscribed
 * is a signal message, so it must follow mute and unmute, not every step of a volume slider.
 */
export function silencedMicsKey(userVolumes: Record<string, number>): string {
  return Object.keys(userVolumes)
    .filter((id) => userVolumes[id] === 0)
    .sort()
    .join(",");
}
