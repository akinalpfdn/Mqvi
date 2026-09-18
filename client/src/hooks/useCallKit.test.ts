/**
 * The CallKit screen is put up by the VoIP push even when the app is in the foreground, and the
 * server excludes the device that acted from the cancel push. So whoever takes the call inside
 * the app has to take that screen down — and must not take it down while it is still ringing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { endCall, setMuted, getVoipToken, addListener, nativeListeners } = vi.hoisted(() => {
  const nativeListeners: Record<string, (data: { call_id: string; muted?: boolean }) => void> = {};
  return {
    nativeListeners,
    endCall: vi.fn(async () => {}),
    setMuted: vi.fn(async () => {}),
    getVoipToken: vi.fn(async () => ({ token: "" })),
    addListener: vi.fn(async (event: string, cb: (data: { call_id: string; muted?: boolean }) => void) => {
      nativeListeners[event] = cb;
      return { remove: vi.fn() };
    }),
  };
});

vi.mock("../native/p2pCall", () => ({
  P2PCall: { endCall, setMuted, getVoipToken, addListener },
  dismissIncomingCallUI: vi.fn(),
}));
vi.mock("../api/push", () => ({ registerPushToken: vi.fn(async () => ({ success: true })) }));
vi.mock("../utils/pushToken", () => ({ syncVoipToken: vi.fn(async () => {}) }));
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock("../utils/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/constants")>()),
  getCapacitorPlatform: () => "ios",
}));

import { useCallKit } from "./useCallKit";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useAuthStore } from "../stores/authStore";
import type { P2PCall as P2PCallType } from "../types";

const CALL_ID = "call-1";

function ringingCall(): P2PCallType {
  return {
    id: CALL_ID,
    caller_id: "them",
    caller_username: "them",
    caller_display_name: null,
    caller_avatar: null,
    receiver_id: "me",
    receiver_username: "me",
    receiver_display_name: null,
    receiver_avatar: null,
    call_type: "voice",
    status: "ringing",
    created_at: "2026-09-16 10:00:00",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "me", username: "me" } as never });
  useP2PCallStore.setState({
    activeCall: null,
    incomingCall: null,
    systemRingingCallId: null,
    _localEnd: null,
    _sendWS: vi.fn(),
    _sessionId: "session-1",
  } as never);
});

afterEach(() => {
  useP2PCallStore.getState().cleanup();
});

describe("useCallKit — dismissing the system call screen", () => {
  it("should not dismiss anything while the call is still ringing", () => {
    renderHook(() => useCallKit());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());

    expect(endCall).not.toHaveBeenCalled();
  });

  it("should dismiss the call screen when the call is answered inside the app", () => {
    renderHook(() => useCallKit());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });

    expect(endCall).toHaveBeenCalledWith({ call_id: CALL_ID, reason: "answeredElsewhere" });
    expect(endCall).toHaveBeenCalledTimes(1);
  });

  it("should dismiss the call screen when the call is declined inside the app", () => {
    renderHook(() => useCallKit());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    useP2PCallStore.getState().declineCall(CALL_ID);

    expect(endCall).toHaveBeenCalledWith({ call_id: CALL_ID, reason: "local" });
  });

  it("should record a call cleared without this device ending it as ended by the other side", () => {
    renderHook(() => useCallKit());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    useP2PCallStore.setState({ activeCall: null, incomingCall: null });

    expect(endCall).toHaveBeenCalledWith({ call_id: CALL_ID, reason: "remoteEnded" });
  });

  it("should keep the system call alive when the user answered in CallKit, and drop it at the end", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callAnswered).toBeDefined());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    nativeListeners.callAnswered({ call_id: CALL_ID });
    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });

    expect(endCall).not.toHaveBeenCalled();

    useP2PCallStore.getState().endCall();
    expect(endCall).toHaveBeenCalledWith({ call_id: CALL_ID, reason: "local" });
  });

  it("should record a call whose media failed as failed, not as the user's hang-up", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callAnswered).toBeDefined());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    nativeListeners.callAnswered({ call_id: CALL_ID });
    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });
    useP2PCallStore.getState().endCall("failed");

    expect(endCall).toHaveBeenCalledWith({ call_id: CALL_ID, reason: "failed" });
  });

  it("should mark the call as ringing in the system, and clear it once answered", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callReported).toBeDefined());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    nativeListeners.callReported({ call_id: CALL_ID });
    expect(useP2PCallStore.getState().systemRingingCallId).toBe(CALL_ID);

    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });
    expect(useP2PCallStore.getState().systemRingingCallId).toBeNull();
  });

  it("should leave the in-app ring alone when CallKit never reported the call", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callReported).toBeDefined());

    // Push withheld (invisible receiver) — no callReported ever arrives.
    useP2PCallStore.getState().handleCallInitiate(ringingCall());

    expect(useP2PCallStore.getState().systemRingingCallId).toBeNull();
  });

  it("should mirror the system mute button into the call", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callMuted).toBeDefined());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });

    nativeListeners.callMuted({ call_id: CALL_ID, muted: true } as never);
    expect(useP2PCallStore.getState().isMuted).toBe(true);

    // Already muted — a repeat must not toggle it back on.
    nativeListeners.callMuted({ call_id: CALL_ID, muted: true } as never);
    expect(useP2PCallStore.getState().isMuted).toBe(true);

    nativeListeners.callMuted({ call_id: CALL_ID, muted: false } as never);
    expect(useP2PCallStore.getState().isMuted).toBe(false);
  });

  it("should mirror an in-app mute onto the system call screen", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callMuted).toBeDefined());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });

    useP2PCallStore.getState().toggleMute();
    expect(setMuted).toHaveBeenLastCalledWith({ call_id: CALL_ID, muted: true });
    useP2PCallStore.getState().toggleMute();
    expect(setMuted).toHaveBeenLastCalledWith({ call_id: CALL_ID, muted: false });
  });

  it("should keep the CallKit flag when the push beats the WS event", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callReported).toBeDefined());

    nativeListeners.callReported({ call_id: CALL_ID }); // app woken by the push, no call yet
    expect(useP2PCallStore.getState().systemRingingCallId).toBe(CALL_ID);

    useP2PCallStore.getState().handleCallInitiate(ringingCall()); // the WS catches up
    expect(useP2PCallStore.getState().systemRingingCallId).toBe(CALL_ID);

    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });
    expect(useP2PCallStore.getState().systemRingingCallId).toBeNull();
  });

  it("should decline a call rejected on CallKit before it reached the app", async () => {
    const sendWS = vi.fn();
    useP2PCallStore.setState({ _sendWS: sendWS });
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callEnded).toBeDefined());

    nativeListeners.callEnded({ call_id: CALL_ID }); // "Decline" on the lock screen
    expect(sendWS).toHaveBeenCalledWith("p2p_call_decline", { call_id: CALL_ID });
    expect(useP2PCallStore.getState().systemRingingCallId).toBeNull();

    // The server re-delivers it on connect; it must not ring in the app.
    sendWS.mockClear();
    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    expect(useP2PCallStore.getState().incomingCall).toBeNull();
    expect(sendWS).toHaveBeenCalledWith("p2p_call_decline", { call_id: CALL_ID });
  });

  it("should accept again when the server re-delivers a call whose CallKit answer was lost", async () => {
    const sendWS = vi.fn();
    useP2PCallStore.setState({ _sendWS: sendWS });
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callAnswered).toBeDefined());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    nativeListeners.callAnswered({ call_id: CALL_ID }); // lock screen; the socket under it is dead
    expect(sendWS).toHaveBeenCalledTimes(1);

    useP2PCallStore.setState({ callDuration: 1 }); // unrelated updates do not resend
    expect(sendWS).toHaveBeenCalledTimes(1);

    useP2PCallStore.getState().handleCallInitiate(ringingCall()); // reconnect re-delivers it
    expect(sendWS).toHaveBeenCalledTimes(2);
    expect(sendWS).toHaveBeenLastCalledWith("p2p_call_accept", { call_id: CALL_ID });
  });

  it("should accept a call answered on CallKit once it reaches the app, and only until it is active", async () => {
    const sendWS = vi.fn();
    useP2PCallStore.setState({ _sendWS: sendWS });
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callAnswered).toBeDefined());

    nativeListeners.callAnswered({ call_id: CALL_ID }); // cold launch, no call yet
    expect(sendWS).not.toHaveBeenCalled();

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    expect(sendWS).toHaveBeenCalledWith("p2p_call_accept", { call_id: CALL_ID });

    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });
    useP2PCallStore.getState().endCall();
    sendWS.mockClear();
    useP2PCallStore.getState().handleCallInitiate(ringingCall()); // a stale re-delivery
    expect(sendWS).not.toHaveBeenCalledWith("p2p_call_accept", expect.anything());
  });

  it("should keep a CallKit mute made before the call reached the app", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callMuted).toBeDefined());

    nativeListeners.callMuted({ call_id: CALL_ID, muted: true } as never); // WS not connected yet
    expect(useP2PCallStore.getState().isMuted).toBe(false);

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    expect(useP2PCallStore.getState().isMuted).toBe(true);
  });

  it("should leave an outgoing call alone", () => {
    renderHook(() => useCallKit());

    const outgoing: P2PCallType = { ...ringingCall(), caller_id: "me", receiver_id: "them", initiated_by: "session-1" };
    useP2PCallStore.getState().handleCallInitiate(outgoing);
    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });
    useP2PCallStore.setState({ activeCall: null, incomingCall: null });

    expect(endCall).not.toHaveBeenCalled();
  });
});
