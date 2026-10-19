/**
 * Whether to receive a participant's mic at all.
 *
 * Deafen and a volume of 0 — local mute is one — refuse the subscription instead of playing it at
 * 0: a freshly subscribed track starts on a new gain node at full volume, and livekit-client never
 * carries a stored volume of 0 over to it (it tests `if (this.elementVolume)`), so the 0 only lands
 * on a later setVolume and then fades in over ~0.3s. That was a second of a muted person's voice on
 * every join.
 */
export function shouldReceiveMic(
  state: {
    isDeafened: boolean;
    isServerDeafened: boolean;
    masterVolume: number;
    userVolumes: Record<string, number>;
  },
  identity: string
): boolean {
  return (
    !state.isDeafened &&
    !state.isServerDeafened &&
    state.masterVolume > 0 &&
    (state.userVolumes[identity] ?? 100) > 0
  );
}
