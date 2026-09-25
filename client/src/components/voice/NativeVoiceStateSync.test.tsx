/**
 * On iOS the voice user menu's volume and local mute only wrote the store, which nothing applied to
 * the native room; a moderator's deafen did not reach it either. They reach the plugin now.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { RemoteAudioGains } from "../../utils/remoteAudioGain";

const { setRemoteVolumes } = vi.hoisted(() => ({
  setRemoteVolumes: vi.fn<(gains: RemoteAudioGains) => Promise<void>>(async () => {}),
}));
vi.mock("../../utils/nativePlugins", () => ({ nativeVoiceSetRemoteVolumes: setRemoteVolumes }));
vi.mock("../../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return {
    useVoiceStore: create(() => ({
      userVolumes: {} as Record<string, number>,
      screenShareVolumes: {} as Record<string, number>,
      masterVolume: 100,
      isDeafened: false,
      isServerDeafened: false,
    })),
  };
});

import NativeVoiceStateSync from "./NativeVoiceStateSync";
import { useVoiceStore } from "../../stores/voiceStore";

function lastGains() {
  return setRemoteVolumes.mock.lastCall?.[0];
}

beforeEach(() => {
  setRemoteVolumes.mockClear();
  useVoiceStore.setState({
    userVolumes: { alice: 150 },
    screenShareVolumes: {},
    masterVolume: 100,
    isDeafened: false,
    isServerDeafened: false,
  });
});

describe("native voice volumes", () => {
  it("gives the native room the saved volumes on joining", () => {
    render(<NativeVoiceStateSync />);

    expect(lastGains()).toEqual({ microphone: { alice: 1.5 }, screenShare: {}, fallback: 1 });
  });

  it("follows the volume slider and the local mute", () => {
    render(<NativeVoiceStateSync />);

    act(() => useVoiceStore.setState({ userVolumes: { alice: 50 } }));
    expect(lastGains()?.microphone.alice).toBe(0.5);

    // What toggleLocalMute writes.
    act(() => useVoiceStore.setState({ userVolumes: { alice: 0 } }));
    expect(lastGains()?.microphone.alice).toBe(0);
  });

  it("silences everyone when a moderator deafens you", () => {
    render(<NativeVoiceStateSync />);

    act(() => useVoiceStore.setState({ isServerDeafened: true }));

    expect(lastGains()).toEqual({ microphone: { alice: 0 }, screenShare: {}, fallback: 0 });
  });
});
