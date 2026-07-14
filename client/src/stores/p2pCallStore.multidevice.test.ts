/**
 * A call belongs to two CONNECTIONS, not two users. The user's phone, desktop and tablet all
 * hold a socket and all receive every event for the call — so every handler has to work out
 * whether the event is about THIS device or a sibling. Getting that wrong is not cosmetic: the
 * losing device opens a microphone and answers the caller's offer alongside the one that really
 * answered. None of this had a test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/calls", () => ({ fetchIceServers: vi.fn(), fetchIceServersForRecovery: vi.fn() }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

const addToast = vi.fn();
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast }) } }));

const dismissIncomingCallUI = vi.fn();
vi.mock("../native/p2pCall", () => ({
  dismissIncomingCallUI: (id: string) => dismissIncomingCallUI(id),
  presentIncomingCallUI: vi.fn(),
}));

import { useP2PCallStore } from "./p2pCallStore";
import { useAuthStore } from "./authStore";
import type { P2PCall } from "../types";

const ME = "me";
const THEM = "them";
const THIS_DEVICE = "session-phone";
const SIBLING = "session-desktop";

function call(over: Partial<P2PCall> = {}): P2PCall {
  return {
    id: "call-1",
    caller_id: THEM,
    caller_username: "them",
    caller_display_name: null,
    caller_avatar: null,
    receiver_id: ME,
    receiver_username: "me",
    receiver_display_name: null,
    receiver_avatar: null,
    call_type: "voice",
    status: "ringing",
    created_at: "",
    ...over,
  } as P2PCall;
}

function reset(sessionId: string | null = THIS_DEVICE) {
  useAuthStore.setState({ user: { id: ME, username: "me" } as never });
  useP2PCallStore.setState({
    activeCall: null,
    incomingCall: null,
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    _durationInterval: null,
    _pendingCandidates: [],
    _triggerIceRestart: null,
    _sessionId: sessionId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

describe("handleCallAccept — exactly one device may answer", () => {
  it("goes active on the device that actually answered", () => {
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call() });

    useP2PCallStore.getState().handleCallAccept({ call_id: "call-1", accepted_by: THIS_DEVICE });

    expect(useP2PCallStore.getState().activeCall?.status).toBe("active");
    expect(useP2PCallStore.getState().incomingCall).toBeNull();
  });

  // The bug this exists for: the sibling fell through, flipped to active, opened a microphone,
  // and answered the caller's offer alongside the device the user actually picked up on.
  it("tears down the sibling devices that did not answer", () => {
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call() });

    useP2PCallStore.getState().handleCallAccept({ call_id: "call-1", accepted_by: SIBLING });

    const s = useP2PCallStore.getState();
    expect(s.activeCall).toBeNull();
    expect(s.incomingCall).toBeNull();
    expect(dismissIncomingCallUI).toHaveBeenCalledWith("call-1");
  });

  // The caller is not a receiver device. accepted_by names one of the RECEIVER's sessions, so it
  // will never equal the caller's session — the caller must not read it as "not mine".
  it("goes active on the caller even though accepted_by is a stranger's session", () => {
    useP2PCallStore.setState({
      activeCall: call({ caller_id: ME, receiver_id: THEM }),
      incomingCall: null,
    });

    useP2PCallStore.getState().handleCallAccept({ call_id: "call-1", accepted_by: SIBLING });

    expect(useP2PCallStore.getState().activeCall?.status).toBe("active");
  });

  // Old server, no accepted_by: there is nothing to compare, so nobody may be torn down.
  it("goes active when the server does not name the answering session", () => {
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call() });

    useP2PCallStore.getState().handleCallAccept({ call_id: "call-1" });

    expect(useP2PCallStore.getState().activeCall?.status).toBe("active");
  });
});

describe("handleCallInitiate — the caller's other devices are not on the call", () => {
  it("ignores an outgoing call dialled from a sibling device", () => {
    const outgoing = call({ caller_id: ME, receiver_id: THEM, initiated_by: SIBLING } as never);

    useP2PCallStore.getState().handleCallInitiate(outgoing);

    const s = useP2PCallStore.getState();
    expect(s.activeCall).toBeNull();
    expect(s.incomingCall).toBeNull();
  });

  it("takes the call on the device that dialled it", () => {
    const outgoing = call({ caller_id: ME, receiver_id: THEM, initiated_by: THIS_DEVICE } as never);

    useP2PCallStore.getState().handleCallInitiate(outgoing);

    expect(useP2PCallStore.getState().activeCall?.id).toBe("call-1");
  });

  // An INCOMING call must ring on every device the user owns — the sibling filter is about the
  // caller's own devices, and applying it here would mean the phone never rings.
  it("rings on every device for an incoming call", () => {
    useP2PCallStore.getState().handleCallInitiate(call({ initiated_by: SIBLING } as never));

    expect(useP2PCallStore.getState().incomingCall?.id).toBe("call-1");
  });
});

describe("handleCallDecline — declining on one device is not a rejection to yourself", () => {
  it("tears down quietly when we declined it on another of our devices", () => {
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call() });

    useP2PCallStore.getState().handleCallDecline({ call_id: "call-1", declined_by: ME });

    expect(useP2PCallStore.getState().activeCall).toBeNull();
    expect(dismissIncomingCallUI).toHaveBeenCalledWith("call-1");
    // "Call declined" is what the OTHER party is told. Showing it to the person who declined is
    // the app telling you that you rejected yourself.
    expect(addToast).not.toHaveBeenCalled();
  });

  it("tells the caller when the other party declined", () => {
    useP2PCallStore.setState({
      activeCall: call({ caller_id: ME, receiver_id: THEM }),
      incomingCall: null,
    });

    useP2PCallStore.getState().handleCallDecline({ call_id: "call-1", declined_by: THEM });

    expect(useP2PCallStore.getState().activeCall).toBeNull();
    expect(addToast).toHaveBeenCalledWith("info", "common:callDeclined");
  });

  it("stops the ring on a sibling that only had it as an incoming call", () => {
    useP2PCallStore.setState({ activeCall: null, incomingCall: call() });

    useP2PCallStore.getState().handleCallDecline({ call_id: "call-1", declined_by: ME });

    expect(useP2PCallStore.getState().incomingCall).toBeNull();
    expect(dismissIncomingCallUI).toHaveBeenCalledWith("call-1");
  });
});
