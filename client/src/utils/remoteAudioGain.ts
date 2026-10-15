/**
 * The playout gain of each remote user's audio in channel voice, as VoiceStateManager applies it
 * to the page's LiveKit room: per-user volume times the master volume, and silence while deafened,
 * by yourself or by a moderator (server deafen is enforced only here, never by the SFU).
 * On iOS the native room applies these same numbers.
 */

export type RemoteAudioGainInputs = {
  /** Percent per user, 0–200; a local mute is 0. */
  userVolumes: Record<string, number>;
  screenShareVolumes: Record<string, number>;
  masterVolume: number;
  isDeafened: boolean;
  isServerDeafened: boolean;
};

export type RemoteAudioGains = {
  microphone: Record<string, number>;
  screenShare: Record<string, number>;
  /** For anyone with no volume of their own. */
  fallback: number;
};

export function remoteAudioGains(inputs: RemoteAudioGainInputs): RemoteAudioGains {
  const deafened = inputs.isDeafened || inputs.isServerDeafened;
  const master = inputs.masterVolume / 100;
  const gain = (percent: number) => (deafened ? 0 : (percent / 100) * master);
  const each = (volumes: Record<string, number>) =>
    Object.fromEntries(Object.entries(volumes).map(([userId, percent]) => [userId, gain(percent)]));

  return {
    microphone: each(inputs.userVolumes),
    screenShare: each(inputs.screenShareVolumes),
    fallback: gain(100),
  };
}
