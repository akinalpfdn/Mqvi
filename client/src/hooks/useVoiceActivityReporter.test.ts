import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVoiceActivityReporter } from "./useVoiceActivityReporter";
import { useVoiceStore } from "../stores/voiceStore";
import { useAuthStore } from "../stores/authStore";
import type { User } from "../types";

const TICK = 30_000;

type ElectronWindow = { electronAPI?: { getSystemIdleTime: () => Promise<number> } };

function setSystemIdle(seconds: number) {
  (window as unknown as ElectronWindow).electronAPI = { getSystemIdleTime: async () => seconds };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mounts the reporter in voice and drops the ping it sends on join. */
async function mountInVoice() {
  const sendWS = vi.fn();
  renderHook(() => useVoiceActivityReporter({ sendWS }));
  await advance(0);
  sendWS.mockClear();
  return sendWS;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Fixture: only the id is read.
  useAuthStore.setState({ user: { id: "me" } as User });
  useVoiceStore.setState({
    currentVoiceChannelId: "voice-1",
    activeSpeakers: {},
    isStreaming: false,
    watchingScreenShares: {},
  });
});

afterEach(() => {
  delete (window as unknown as ElectronWindow).electronAPI;
  vi.useRealTimers();
});

describe("useVoiceActivityReporter", () => {
  it("should not report activity when only another participant is speaking", async () => {
    const sendWS = await mountInVoice();

    act(() => useVoiceStore.setState({ activeSpeakers: { someoneElse: true } }));
    await advance(TICK * 3);

    expect(sendWS).not.toHaveBeenCalled();
  });

  it("should report activity when the local user speaks between two ticks", async () => {
    const sendWS = await mountInVoice();
    await advance(TICK);

    act(() => useVoiceStore.setState({ activeSpeakers: { me: true } }));
    act(() => useVoiceStore.setState({ activeSpeakers: {} }));
    await advance(TICK);

    expect(sendWS).toHaveBeenCalledWith("voice_activity");
  });

  it("should report activity on desktop when there was input in another app since the last tick", async () => {
    setSystemIdle(5);
    const sendWS = await mountInVoice();

    await advance(TICK);

    expect(sendWS).toHaveBeenCalledWith("voice_activity");
  });

  it("should not report activity on desktop when the computer has been untouched for a whole tick", async () => {
    setSystemIdle(TICK / 1000);
    const sendWS = await mountInVoice();

    await advance(TICK * 3);

    expect(sendWS).not.toHaveBeenCalled();
  });

  it("should keep reporting activity while the user is streaming", async () => {
    const sendWS = await mountInVoice();

    act(() => useVoiceStore.setState({ isStreaming: true }));
    await advance(TICK);

    expect(sendWS).toHaveBeenCalledWith("voice_activity");
  });

  it("should not report activity when the user is not in voice", async () => {
    setSystemIdle(0);
    useVoiceStore.setState({ currentVoiceChannelId: null, activeSpeakers: { me: true } });
    const sendWS = vi.fn();
    renderHook(() => useVoiceActivityReporter({ sendWS }));

    await advance(TICK * 2);

    expect(sendWS).not.toHaveBeenCalled();
  });
});
