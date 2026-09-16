/**
 * The CallKit screen is put up by the VoIP push even when the app is in the foreground, and the
 * server excludes the device that acted from the cancel push. So whoever takes the call inside
 * the app has to take that screen down — and must not take it down while it is still ringing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { endCall, getVoipToken, addListener, nativeListeners } = vi.hoisted(() => {
  const nativeListeners: Record<string, (data: { call_id: string }) => void> = {};
  return {
    nativeListeners,
    endCall: vi.fn(async () => {}),
    getVoipToken: vi.fn(async () => ({ token: "" })),
    addListener: vi.fn(async (event: string, cb: (data: { call_id: string }) => void) => {
      nativeListeners[event] = cb;
      return { remove: vi.fn() };
    }),
  };
});

vi.mock("../native/p2pCall", () => ({
  P2PCall: { endCall, getVoipToken, addListener },
  dismissIncomingCallUI: vi.fn(),
}));
vi.mock("../api/push", () => ({ registerPushToken: vi.fn(async () => ({ success: true })) }));
vi.mock("../utils/pushToken", () => ({ cacheVoipToken: vi.fn() }));
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

    expect(endCall).toHaveBeenCalledWith({ call_id: CALL_ID });
    expect(endCall).toHaveBeenCalledTimes(1);
  });

  it("should dismiss the call screen when the call is declined inside the app", () => {
    renderHook(() => useCallKit());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    useP2PCallStore.setState({ activeCall: null, incomingCall: null });

    expect(endCall).toHaveBeenCalledWith({ call_id: CALL_ID });
  });

  it("should keep the system call alive when the user answered in CallKit, and drop it at the end", async () => {
    renderHook(() => useCallKit());
    await waitFor(() => expect(nativeListeners.callAnswered).toBeDefined());

    useP2PCallStore.getState().handleCallInitiate(ringingCall());
    nativeListeners.callAnswered({ call_id: CALL_ID });
    useP2PCallStore.getState().handleCallAccept({ call_id: CALL_ID, accepted_by: "session-1" });

    expect(endCall).not.toHaveBeenCalled();

    useP2PCallStore.setState({ activeCall: null, incomingCall: null });
    expect(endCall).toHaveBeenCalledWith({ call_id: CALL_ID });
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
