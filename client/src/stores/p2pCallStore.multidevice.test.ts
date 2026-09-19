/**
 * A call belongs to two CONNECTIONS, not two users. The user's phone, desktop and tablet all
 * hold a socket and all receive every event for the call — so every handler has to work out
 * whether the event is about THIS device or a sibling. Getting that wrong is not cosmetic: the
 * losing device opens a microphone and answers the caller's offer alongside the one that really
 * answered. None of this had a test.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../api/calls", () => ({ fetchIceServers: vi.fn(), fetchIceServersForRecovery: vi.fn() }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

const addToast = vi.fn();
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast }) } }));

const dismissIncomingCallUI = vi.fn();
vi.mock("../native/p2pCall", () => ({
  dismissIncomingCallUI: (id: string, reason?: string) => dismissIncomingCallUI(id, reason),
  presentIncomingCallUI: vi.fn(),
}));

import { useP2PCallStore } from "./p2pCallStore";
import { INSTANCE_ID } from "../utils/deviceId";
import { endP2PCallForLogout } from "./shared/p2pCallControl";
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
    engine: null,
    _durationInterval: null,
    _acceptSentFor: null,
    _localEnd: null,
    _endedHere: {},
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
    expect(dismissIncomingCallUI).toHaveBeenCalledWith("call-1", "answeredElsewhere");
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
    expect(dismissIncomingCallUI).toHaveBeenCalledWith("call-1", "declinedElsewhere");
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
    expect(dismissIncomingCallUI).toHaveBeenCalledWith("call-1", "declinedElsewhere");
  });
});

// REVIEW-02 #5: the socket carrying the call died and this one replaced it. Media is peer-to-peer
// and never stopped — but the server scheduled a teardown when the old socket closed, and it
// identifies the call by SESSION, which just changed. Claim it back, or it is hung up under us.
describe("resumeCallAfterReconnect", () => {
  const sent: { op: string; data?: unknown }[] = [];

  beforeEach(() => {
    sent.length = 0;
    useP2PCallStore.getState().registerSendWS((op, data) => sent.push({ op, data }));
  });

  it("reclaims a live call", () => {
    useP2PCallStore.setState({ activeCall: call({ status: "active" }) });

    useP2PCallStore.getState().resumeCallAfterReconnect();

    // Resume first: the server only relays signals from the session that owns the call.
    expect(sent).toEqual([
      { op: "p2p_call_resume", data: { call_id: "call-1" } },
      { op: "p2p_signal", data: { call_id: "call-1", type: "video-query" } },
    ]);
  });

  it("says nothing when there is no call", () => {
    useP2PCallStore.setState({ activeCall: null });

    useP2PCallStore.getState().resumeCallAfterReconnect();

    expect(sent).toEqual([]);
  });

  // Its end may have gone to the dead socket; a ringing caller's call must also move to this one.
  it("asks about a call that is still ringing", () => {
    useP2PCallStore.setState({ activeCall: call({ status: "ringing" }) });

    useP2PCallStore.getState().resumeCallAfterReconnect();

    expect(sent).toEqual([{ op: "p2p_call_resume", data: { call_id: "call-1" } }]);
  });

  it("asks about an incoming call ringing on top of the current one", () => {
    useP2PCallStore.setState({ activeCall: call({ id: "call-0", status: "active" }), incomingCall: call() });

    useP2PCallStore.getState().resumeCallAfterReconnect();

    expect(sent[0]).toEqual({ op: "p2p_call_resume", data: { call_id: "call-1" } });
    expect(sent[1]).toEqual({ op: "p2p_call_resume", data: { call_id: "call-0" } });
  });

  // Answered, and the socket died before the confirmation came back: nothing else re-sends it.
  it("accepts again a call this device answered that is still ringing here", () => {
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call(), _acceptSentFor: "call-1" });

    useP2PCallStore.getState().resumeCallAfterReconnect();

    expect(sent).toEqual([{ op: "p2p_call_accept", data: { call_id: "call-1" } }]);
  });
});

describe("declineCall — after answering, it is a hang-up", () => {
  const sent: { op: string; data?: unknown }[] = [];

  beforeEach(() => {
    sent.length = 0;
    useP2PCallStore.getState().registerSendWS((op, data) => sent.push({ op, data }));
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call() });
  });

  // The server may already hold the call as active, where it refuses a decline and the caller
  // sits in a silent call.
  it("ends a call already accepted instead of declining it", () => {
    useP2PCallStore.getState().acceptCall("call-1");
    sent.length = 0;

    useP2PCallStore.getState().declineCall("call-1");

    expect(sent).toEqual([{ op: "p2p_call_end", data: { call_id: "call-1" } }]);
    expect(useP2PCallStore.getState().activeCall).toBeNull();
    expect(useP2PCallStore.getState().incomingCall).toBeNull();
  });

  it("declines a call not yet accepted", () => {
    useP2PCallStore.getState().declineCall("call-1");

    expect(sent).toEqual([{ op: "p2p_call_decline", data: { call_id: "call-1" } }]);
  });
});

describe("handleCallEnd — the phone's call history says how the call ended", () => {
  it.each([
    ["timeout", "unanswered"],
    ["disconnect", "failed"],
    [undefined, "remoteEnded"],
  ])("records an end with reason %s as %s", (reason, expected) => {
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call() });

    useP2PCallStore.getState().handleCallEnd({ call_id: "call-1", reason });

    expect(dismissIncomingCallUI).toHaveBeenCalledWith("call-1", expected);
  });
});

describe("recognising this app across a reconnect", () => {
  // The accept was sent from the old socket; its broadcast arrives on the new one.
  it("goes active when its own accept names the old session but this app", () => {
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call(), _sessionId: "session-new" });

    useP2PCallStore.getState().handleCallAccept({
      call_id: "call-1",
      accepted_by: "session-old",
      accepted_by_instance: INSTANCE_ID,
    });

    expect(useP2PCallStore.getState().activeCall?.status).toBe("active");
  });

  it("drops the call when another app answered, whatever the sessions say", () => {
    useP2PCallStore.setState({ activeCall: call(), incomingCall: call() });

    useP2PCallStore.getState().handleCallAccept({
      call_id: "call-1",
      accepted_by: THIS_DEVICE,
      accepted_by_instance: "another-tab",
    });

    expect(useP2PCallStore.getState().activeCall).toBeNull();
  });

  it("keeps its own outgoing call when the initiate lands on a new socket", () => {
    useP2PCallStore.setState({ _sessionId: "session-new" });
    const outgoing = call({ caller_id: ME, receiver_id: THEM, initiated_by: "session-old", initiated_by_instance: INSTANCE_ID } as never);

    useP2PCallStore.getState().handleCallInitiate(outgoing);

    expect(useP2PCallStore.getState().activeCall?.id).toBe("call-1");
  });
});

describe("a call ended here before the server heard", () => {
  const sent: { op: string; data?: unknown }[] = [];

  beforeEach(() => {
    sent.length = 0;
    useP2PCallStore.getState().registerSendWS((op, data) => sent.push({ op, data }));
  });

  // The server re-sends a ringing call on connect, before the queued decline reaches it.
  it.each([
    ["declined", () => useP2PCallStore.getState().declineCall("call-1"), "p2p_call_decline"],
    [
      "declined after answering",
      () => {
        useP2PCallStore.getState().acceptCall("call-1");
        useP2PCallStore.getState().declineCall("call-1");
      },
      "p2p_call_end",
    ],
    [
      "hung up after answering",
      () => {
        useP2PCallStore.getState().acceptCall("call-1");
        useP2PCallStore.getState().endCall();
      },
      "p2p_call_end",
    ],
  ])("does not ring again for a call %s", (_label, end, op) => {
    useP2PCallStore.getState().handleCallInitiate(call());
    end();
    sent.length = 0;

    useP2PCallStore.getState().handleCallInitiate(call());

    expect(useP2PCallStore.getState().incomingCall).toBeNull();
    expect(useP2PCallStore.getState().activeCall).toBeNull();
    expect(sent).toEqual([{ op, data: { call_id: "call-1" } }]);
  });
});

describe("a call the previous page left running", () => {
  // The native side ends its media on reload; the server still thinks the call is up.
  it("is hung up once the socket sender exists, and never rings again", () => {
    useP2PCallStore.setState({ _sendWS: null, _orphanedEnds: [] });
    useP2PCallStore.getState().endOrphanedCall("call-1");

    const sent: { op: string; data?: unknown }[] = [];
    useP2PCallStore.getState().registerSendWS((op, data) => sent.push({ op, data }));
    expect(sent).toEqual([{ op: "p2p_call_end", data: { call_id: "call-1" } }]);

    useP2PCallStore.getState().handleCallInitiate(call());
    expect(useP2PCallStore.getState().incomingCall).toBeNull();
  });

  // The new page is a different app; only the old one may end an answered call.
  it("is hung up in the name of the page that ran it", () => {
    const sent: { op: string; data?: unknown }[] = [];
    useP2PCallStore.getState().registerSendWS((op, data) => sent.push({ op, data }));

    useP2PCallStore.getState().endOrphanedCall("call-1", "old-page");

    expect(sent).toEqual([{ op: "p2p_call_end", data: { call_id: "call-1", instance_id: "old-page" } }]);
  });

  it("is hung up at once when the sender is already there", () => {
    const sent: { op: string; data?: unknown }[] = [];
    useP2PCallStore.getState().registerSendWS((op, data) => sent.push({ op, data }));

    useP2PCallStore.getState().endOrphanedCall("call-1");

    expect(sent).toEqual([{ op: "p2p_call_end", data: { call_id: "call-1" } }]);
  });
});

describe("signing out with a call on screen", () => {
  const sent: { op: string; data?: unknown }[] = [];

  beforeEach(() => {
    sent.length = 0;
    useP2PCallStore.getState().registerSendWS((op, data) => sent.push({ op, data }));
  });

  // Signing out of the desktop is not declining: the phone in the user's hand keeps ringing.
  it("drops an unanswered incoming call here without ending it for the other devices", () => {
    useP2PCallStore.getState().handleCallInitiate(call());

    endP2PCallForLogout();

    expect(useP2PCallStore.getState().activeCall).toBeNull();
    expect(sent).toEqual([]);
  });

  it.each([
    ["an answered call", () => useP2PCallStore.setState({ activeCall: call({ status: "active" }) })],
    ["an incoming call this app accepted", () => {
      useP2PCallStore.getState().handleCallInitiate(call());
      useP2PCallStore.getState().acceptCall("call-1");
    }],
    ["an outgoing call", () => useP2PCallStore.getState().handleCallInitiate(call({ caller_id: ME, receiver_id: THEM }))],
  ])("hangs up %s", (_label, setup) => {
    setup();
    sent.length = 0;

    endP2PCallForLogout();

    expect(sent).toEqual([{ op: "p2p_call_end", data: { call_id: "call-1" } }]);
  });
});

describe("taking over a call a previous page ran", () => {
  const sent: { op: string; data?: unknown }[] = [];
  const candidate = {
    callId: "call-1",
    instanceId: "old-page",
    isCaller: false,
    state: "connected" as const,
    micEnabled: false,
    videoEnabled: true,
    facing: "back" as const,
    remoteVideo: true,
    volume: 150,
    inCallKit: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    useP2PCallStore.setState({ _sessionId: null, _adoptCandidate: null, _adoptTimer: null, _adopted: null });
    useP2PCallStore.getState().registerSendWS((op, data) => sent.push({ op, data }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the call on connect and rebuilds it as the old page left it", () => {
    useP2PCallStore.getState().holdAdoptableCall(candidate);
    useP2PCallStore.getState().resumeCallAfterReconnect();
    expect(sent).toContainEqual({ op: "p2p_call_adopt", data: { call_id: "call-1", instance_id: "old-page" } });

    const acceptedAt = new Date(Date.now() - 90_000).toISOString();
    useP2PCallStore.getState().handleCallAdopted({ ...call({ status: "active" }), accepted_at: acceptedAt });

    const s = useP2PCallStore.getState();
    expect(s.activeCall?.status).toBe("active");
    expect(s.incomingCall).toBeNull();
    expect(s.isMuted).toBe(true);
    expect(s.isVideoOn).toBe(true);
    expect(s.cameraFacing).toBe("back");
    expect(s.remoteVolume).toBe(150);
    expect(s.callDuration).toBeGreaterThanOrEqual(89);
    expect(s._adopted).toEqual({ callId: "call-1", inCallKit: true });
    expect(sent).toContainEqual({ op: "p2p_signal", data: { call_id: "call-1", type: "video-query" } });
  });

  it.each([
    ["the call ended meanwhile", () => useP2PCallStore.getState().handleCallEnd({ call_id: "call-1" })],
    ["another app holds it", () =>
      useP2PCallStore.getState().handleCallAccept({ call_id: "call-1", accepted_by: "x", accepted_by_instance: "tablet" })],
    ["the server never answers", () => vi.advanceTimersByTime(10_000)],
  ])("hangs up in the old page's name when %s", (_label, outcome) => {
    useP2PCallStore.getState().holdAdoptableCall(candidate);
    useP2PCallStore.getState().resumeCallAfterReconnect();
    sent.length = 0;

    outcome();

    expect(useP2PCallStore.getState()._adoptCandidate).toBeNull();
    expect(useP2PCallStore.getState().activeCall).toBeNull();
    expect(sent).toContainEqual({ op: "p2p_call_end", data: { call_id: "call-1", instance_id: "old-page" } });
  });

  // This page connected before it knew about the call, so the server has already released it.
  it("gives the call up at once when the page connected without claiming it", () => {
    useP2PCallStore.setState({ _sessionId: "already-connected" });

    useP2PCallStore.getState().holdAdoptableCall(candidate);

    expect(useP2PCallStore.getState()._adoptCandidate).toBeNull();
    expect(sent).toContainEqual({ op: "p2p_call_end", data: { call_id: "call-1", instance_id: "old-page" } });
  });
});
