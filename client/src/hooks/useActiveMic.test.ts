/**
 * The user bar's microphone is the live one. During an answered call it is the call's: muting it
 * there used to flip channel voice's mute, which nothing was using, while the call kept sending.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create(() => ({ isMuted: false })) };
});
vi.mock("../stores/p2pCallStore", async () => {
  const { create } = await import("zustand");
  return { useP2PCallStore: create(() => ({ activeCall: null, isMuted: false, toggleMute: () => {} })) };
});

import { useVoiceStore } from "../stores/voiceStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useActiveMicMuted, useToggleActiveMute } from "./useActiveMic";
import type { P2PCall } from "../types";

const callToggle = vi.fn();
const voiceToggle = vi.fn();

function call(status: P2PCall["status"]): P2PCall {
  return {
    id: "c1",
    caller_id: "me",
    caller_username: "me",
    caller_display_name: null,
    caller_avatar: null,
    receiver_id: "peer",
    receiver_username: "peer",
    receiver_display_name: null,
    receiver_avatar: null,
    call_type: "voice",
    status,
    created_at: "",
  };
}

beforeEach(() => {
  callToggle.mockClear();
  voiceToggle.mockClear();
  useVoiceStore.setState({ isMuted: false });
  useP2PCallStore.setState({ activeCall: null, isMuted: false, toggleMute: callToggle });
});

describe("the user bar's microphone", () => {
  it("shows and mutes the call's microphone once the call is answered", () => {
    useP2PCallStore.setState({ activeCall: call("active"), isMuted: true });

    expect(renderHook(() => useActiveMicMuted()).result.current).toBe(true);
    renderHook(() => useToggleActiveMute(voiceToggle)).result.current();

    expect(callToggle).toHaveBeenCalledTimes(1);
    expect(voiceToggle).not.toHaveBeenCalled();
  });

  it("follows the call's mute when it changes on the call screen or the lock screen", () => {
    useP2PCallStore.setState({ activeCall: call("active") });
    const { result } = renderHook(() => useActiveMicMuted());
    expect(result.current).toBe(false);

    act(() => useP2PCallStore.setState({ isMuted: true }));

    expect(result.current).toBe(true);
  });

  it("stays on channel voice while a call only rings", () => {
    useVoiceStore.setState({ isMuted: true });
    useP2PCallStore.setState({ activeCall: call("ringing"), isMuted: false });

    expect(renderHook(() => useActiveMicMuted()).result.current).toBe(true);
    renderHook(() => useToggleActiveMute(voiceToggle)).result.current();

    expect(voiceToggle).toHaveBeenCalledTimes(1);
    expect(callToggle).not.toHaveBeenCalled();
  });
});
