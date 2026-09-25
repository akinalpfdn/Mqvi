/**
 * The user bar's microphone and output are the live ones. During an answered call they are the
 * call's: muting or deafening there used to flip channel voice's state, which nothing was using,
 * while the call kept sending and playing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create(() => ({ isMuted: false, isDeafened: false })) };
});
vi.mock("../stores/p2pCallStore", async () => {
  const { create } = await import("zustand");
  return {
    useP2PCallStore: create(() => ({
      activeCall: null,
      isMuted: false,
      isDeafened: false,
      toggleMute: () => {},
      toggleDeafen: () => {},
    })),
  };
});

import { useVoiceStore } from "../stores/voiceStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useActiveDeafened, useActiveMicMuted, useToggleActiveDeafen, useToggleActiveMute } from "./useActiveAudio";
import type { P2PCall } from "../types";

const callToggleMute = vi.fn();
const callToggleDeafen = vi.fn();
const voiceToggleMute = vi.fn();
const voiceToggleDeafen = vi.fn();

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
  vi.clearAllMocks();
  useVoiceStore.setState({ isMuted: false, isDeafened: false });
  useP2PCallStore.setState({
    activeCall: null,
    isMuted: false,
    isDeafened: false,
    toggleMute: callToggleMute,
    toggleDeafen: callToggleDeafen,
  });
});

describe("the user bar's microphone", () => {
  it("shows and mutes the call's microphone once the call is answered", () => {
    useP2PCallStore.setState({ activeCall: call("active"), isMuted: true });

    expect(renderHook(() => useActiveMicMuted()).result.current).toBe(true);
    renderHook(() => useToggleActiveMute(voiceToggleMute)).result.current();

    expect(callToggleMute).toHaveBeenCalledTimes(1);
    expect(voiceToggleMute).not.toHaveBeenCalled();
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
    renderHook(() => useToggleActiveMute(voiceToggleMute)).result.current();

    expect(voiceToggleMute).toHaveBeenCalledTimes(1);
    expect(callToggleMute).not.toHaveBeenCalled();
  });
});

describe("the user bar's deafen", () => {
  it("shows and deafens the call once the call is answered", () => {
    useP2PCallStore.setState({ activeCall: call("active"), isDeafened: true });

    expect(renderHook(() => useActiveDeafened()).result.current).toBe(true);
    renderHook(() => useToggleActiveDeafen(voiceToggleDeafen)).result.current();

    expect(callToggleDeafen).toHaveBeenCalledTimes(1);
    expect(voiceToggleDeafen).not.toHaveBeenCalled();
  });

  it("stays on channel voice while a call only rings", () => {
    useVoiceStore.setState({ isDeafened: true });
    useP2PCallStore.setState({ activeCall: call("ringing") });

    expect(renderHook(() => useActiveDeafened()).result.current).toBe(true);
    renderHook(() => useToggleActiveDeafen(voiceToggleDeafen)).result.current();

    expect(voiceToggleDeafen).toHaveBeenCalledTimes(1);
    expect(callToggleDeafen).not.toHaveBeenCalled();
  });
});
