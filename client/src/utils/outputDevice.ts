/**
 * Whether a saved audio output device is plugged in right now: true, false, or null when the
 * browser will not say (no media permission yet, so every device id comes back empty).
 *
 * A saved device that is not there must not be handed to LiveKit: with webAudioMix it passes the id
 * to AudioContext.setSinkId without awaiting it, so the failure escapes as an unhandled rejection
 * and playback is left aimed at a device that does not exist.
 */
export async function outputDeviceAvailable(
  deviceId: string,
  enumerate: () => Promise<MediaDeviceInfo[]> = () => navigator.mediaDevices.enumerateDevices()
): Promise<boolean | null> {
  const outputs = (await enumerate()).filter((d) => d.kind === "audiooutput");
  if (!outputs.some((d) => d.deviceId !== "")) return null;
  return outputs.some((d) => d.deviceId === deviceId);
}
