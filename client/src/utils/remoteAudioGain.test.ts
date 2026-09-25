import { describe, it, expect } from "vitest";

import { remoteAudioGains, type RemoteAudioGainInputs } from "./remoteAudioGain";

const base: RemoteAudioGainInputs = {
  userVolumes: {},
  screenShareVolumes: {},
  masterVolume: 100,
  isDeafened: false,
  isServerDeafened: false,
};

describe("remote audio gains", () => {
  it("scales each user's volume by the master volume", () => {
    const gains = remoteAudioGains({ ...base, userVolumes: { alice: 150, bob: 50 }, masterVolume: 80 });

    expect(gains.microphone.alice).toBeCloseTo(1.2);
    expect(gains.microphone.bob).toBeCloseTo(0.4);
    expect(gains.fallback).toBeCloseTo(0.8);
  });

  it("keeps a local mute silent", () => {
    expect(remoteAudioGains({ ...base, userVolumes: { alice: 0 } }).microphone.alice).toBe(0);
  });

  it("amplifies up to twice, as the volume slider allows", () => {
    expect(remoteAudioGains({ ...base, userVolumes: { alice: 200 } }).microphone.alice).toBe(2);
  });

  it("silences everyone while a moderator has deafened you", () => {
    const gains = remoteAudioGains({
      ...base,
      userVolumes: { alice: 150 },
      screenShareVolumes: { alice: 100 },
      isServerDeafened: true,
    });

    expect(gains.microphone.alice).toBe(0);
    expect(gains.screenShare.alice).toBe(0);
    expect(gains.fallback).toBe(0);
  });

  it("silences everyone while you have deafened yourself", () => {
    expect(remoteAudioGains({ ...base, isDeafened: true }).fallback).toBe(0);
  });
});
