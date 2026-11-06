/**
 * Whether a saved audio device can be used on this machine right now.
 *
 * Device ids are hashed per machine, so an id chosen on another machine never matches here. They
 * used to be synced between machines with the rest of the voice settings, so one may still be
 * saved. The ids this machine has listed before are remembered, which tells a device that is only
 * unplugged ("missing") from one that was never here ("foreign").
 *
 * A saved device that is not there must not be handed to LiveKit: with webAudioMix it passes the id
 * to AudioContext.setSinkId without awaiting it, so the failure escapes as an unhandled rejection
 * and playback is left aimed at a device that does not exist.
 */

export type SavedDeviceStatus =
  /** Plugged in now. */
  | "present"
  /** Listed on this machine before, not plugged in now. */
  | "missing"
  /** Never listed on this machine: chosen on another one. */
  | "foreign"
  /** The browser hides device ids (no media permission yet). */
  | "unknown";

export type AudioDeviceKind = "audioinput" | "audiooutput";

const SEEN_KEY = "mqvi_seen_audio_devices";
/** Per kind. Past it the oldest are forgotten, which only costs the "missing" warning for them. */
export const SEEN_MAX = 64;

type SeenDevices = Record<AudioDeviceKind, string[]>;

function readSeen(storage: Storage): SeenDevices {
  try {
    const parsed = JSON.parse(storage.getItem(SEEN_KEY) ?? "null") as Partial<Record<string, unknown>> | null;
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
    return { audioinput: ids(parsed?.audioinput), audiooutput: ids(parsed?.audiooutput) };
  } catch {
    return { audioinput: [], audiooutput: [] };
  }
}

/** Records the audio devices listed on this machine. Empty ids (no permission) say nothing. */
export function rememberAudioDevices(
  devices: Pick<MediaDeviceInfo, "kind" | "deviceId">[],
  storage: Storage = localStorage
): void {
  const seen = readSeen(storage);
  let changed = false;
  for (const { kind, deviceId } of devices) {
    if ((kind !== "audioinput" && kind !== "audiooutput") || !deviceId) continue;
    const ids = seen[kind];
    if (ids.includes(deviceId)) continue;
    ids.push(deviceId);
    if (ids.length > SEEN_MAX) ids.splice(0, ids.length - SEEN_MAX);
    changed = true;
  }
  if (!changed) return;
  try {
    storage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* storage full or unavailable: the warning for an unplugged device is all that is lost */
  }
}

export async function savedDeviceStatus(
  kind: AudioDeviceKind,
  deviceId: string,
  enumerate: () => Promise<MediaDeviceInfo[]> = () => navigator.mediaDevices.enumerateDevices(),
  storage: Storage = localStorage
): Promise<SavedDeviceStatus> {
  const devices = await enumerate();
  const ofKind = devices.filter((d) => d.kind === kind);
  if (!ofKind.some((d) => d.deviceId !== "")) return "unknown";

  const seenBefore = readSeen(storage)[kind].includes(deviceId);
  rememberAudioDevices(devices, storage);

  if (ofKind.some((d) => d.deviceId === deviceId)) return "present";
  return seenBefore ? "missing" : "foreign";
}
