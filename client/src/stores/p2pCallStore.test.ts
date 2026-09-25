import { describe, it, expect, beforeEach, vi } from "vitest";

// Module-level imports of p2pCallStore — stub them so the store loads in isolation.
vi.mock("../api/calls", () => ({ fetchIceServers: vi.fn(), fetchIceServersForRecovery: vi.fn() }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("./toastStore", () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

import { useP2PCallStore } from "./p2pCallStore";
import type { P2PCall } from "../types";

function makeCall(overrides: Partial<P2PCall>): P2PCall {
  return {
    id: "call-1",
    caller_id: "caller",
    caller_username: "caller",
    caller_display_name: null,
    caller_avatar: null,
    receiver_id: "receiver",
    receiver_username: "receiver",
    receiver_display_name: null,
    receiver_avatar: null,
    call_type: "voice",
    status: "active",
    created_at: "",
    ...overrides,
  };
}

beforeEach(() => {
  addToast.mockClear();
  useP2PCallStore.setState({
    activeCall: null,
    incomingCall: null,
    localStream: null,
    remoteStream: null,
    engine: null,
    _durationInterval: null,
  });
});

describe("handleCallEnd — stale-call protection", () => {
  it("ignores an end event for a call we already left", () => {
    useP2PCallStore.setState({ activeCall: makeCall({ id: "B", status: "active" }) });
    useP2PCallStore.getState().handleCallEnd({ call_id: "A" });
    expect(useP2PCallStore.getState().activeCall?.id).toBe("B");
  });

  it("ends the call when the id matches", () => {
    useP2PCallStore.setState({ activeCall: makeCall({ id: "B", status: "active" }) });
    useP2PCallStore.getState().handleCallEnd({ call_id: "B" });
    expect(useP2PCallStore.getState().activeCall).toBeNull();
  });

  it("clears only a matching incoming notification, leaving the active call", () => {
    useP2PCallStore.setState({
      activeCall: makeCall({ id: "B", status: "active" }),
      incomingCall: makeCall({ id: "C", status: "ringing" }),
    });
    useP2PCallStore.getState().handleCallEnd({ call_id: "C" });
    expect(useP2PCallStore.getState().incomingCall).toBeNull();
    expect(useP2PCallStore.getState().activeCall?.id).toBe("B");
  });
});

describe("handleCallBusy — stale-busy protection", () => {
  it("does not tear down an unrelated active call", () => {
    useP2PCallStore.setState({ activeCall: makeCall({ id: "B", status: "active", receiver_id: "Y" }) });
    useP2PCallStore.getState().handleCallBusy({ receiver_id: "X" });
    expect(useP2PCallStore.getState().activeCall?.id).toBe("B");
  });

  it("tears down a ringing outgoing attempt to the busy receiver", () => {
    useP2PCallStore.setState({ activeCall: makeCall({ id: "A", status: "ringing", receiver_id: "X" }) });
    useP2PCallStore.getState().handleCallBusy({ receiver_id: "X" });
    expect(useP2PCallStore.getState().activeCall).toBeNull();
  });
});

describe("handleCallError — a refused call says why", () => {
  it("names the reason the server gave", () => {
    useP2PCallStore.getState().handleCallError({ receiver_id: "X", reason: "not_friends" });
    expect(addToast).toHaveBeenCalledWith("warning", "common:callNotFriends");
  });

  it("shows a reason it does not know as a failure", () => {
    useP2PCallStore.getState().handleCallError({ receiver_id: "X", reason: "from_a_newer_server" });
    expect(addToast).toHaveBeenCalledWith("error", "common:callFailed");
  });

  it("leaves the call already on screen alone", () => {
    useP2PCallStore.setState({ activeCall: makeCall({ id: "B", status: "active" }) });
    useP2PCallStore.getState().handleCallError({ receiver_id: "X", reason: "already_in_call" });
    expect(useP2PCallStore.getState().activeCall?.id).toBe("B");
    expect(addToast).toHaveBeenCalledWith("warning", "common:callAlreadyInCall");
  });
});

describe("handleSignal — ice-restart dispatch", () => {
  function engineWithRestart() {
    const restartIce = vi.fn();
    return { restartIce, engine: { restartIce } as never };
  }

  it("asks the engine to restart ICE when the call id matches", () => {
    const { restartIce, engine } = engineWithRestart();
    useP2PCallStore.setState({ activeCall: makeCall({ id: "A", status: "active" }), engine });
    void useP2PCallStore.getState().handleSignal({ call_id: "A", type: "ice-restart" });
    expect(restartIce).toHaveBeenCalledTimes(1);
  });

  it("ignores an ice-restart for a different call", () => {
    const { restartIce, engine } = engineWithRestart();
    useP2PCallStore.setState({ activeCall: makeCall({ id: "A", status: "active" }), engine });
    void useP2PCallStore.getState().handleSignal({ call_id: "B", type: "ice-restart" });
    expect(restartIce).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no engine yet", () => {
    useP2PCallStore.setState({ activeCall: makeCall({ id: "A", status: "active" }), engine: null });
    expect(() => void useP2PCallStore.getState().handleSignal({ call_id: "A", type: "ice-restart" })).not.toThrow();
  });
});
