/**
 * p2pCallStore — P2P call state management.
 *
 * WebRTC P2P flow:
 * - Media flows directly between users (no server relay)
 * - Server only handles signaling (SDP/ICE exchange)
 * - STUN server helps devices behind NAT discover each other
 *
 * Call flow:
 * 1. Caller: initiateCall -> server validate -> broadcast to receiver
 * 2. Receiver: acceptCall -> WebRTC negotiation starts
 * 3. Caller: createOffer -> relay -> Receiver: createAnswer -> relay
 * 4. ICE candidates relayed bidirectionally
 * 5. Media starts flowing P2P
 */

import { create } from "zustand";
import i18n from "../i18n";
import type { CallEngineEvents, CallMediaEngine, CameraFacing } from "../call/CallMediaEngine";
import { NativeCallEngine } from "../call/NativeCallEngine";
import { WebCallEngine } from "../call/WebCallEngine";
import { getCapacitorPlatform } from "../utils/constants";
import { dismissIncomingCallUI } from "../native/p2pCall";
import { NativeP2PCall, type AdoptableCall } from "../native/nativeP2PCall";
import { INSTANCE_ID } from "../utils/deviceId";
import { startVoiceCallService, stopVoiceCallService } from "../utils/nativePlugins";
import type { P2PCall, P2PCallType, P2PSignalPayload } from "../types";
import { useAuthStore } from "./authStore";
import { useToastStore } from "./toastStore";
import { registerP2PCallControl } from "./shared/p2pCallControl";

// ─── Types ───

export type LocalEnd = { callId: string; how: "hungUp" | "declined" | "failed" };

type EndedHere = { op: "p2p_call_decline" | "p2p_call_end"; until: number };

type OrphanedEnd = { call_id: string; instance_id?: string };

/** How long a reloaded page waits for the server to hand it the call its predecessor ran. */
const ADOPT_WAIT_MS = 10_000;

/** Past the ring timeout the server no longer re-sends the call. */
const ENDED_HERE_TTL = 60_000;

type P2PCallStore = {
  /** Active call (ringing or active) — null means not in a call */
  activeCall: P2PCall | null;

  /** Incoming call notification — used by IncomingCallOverlay */
  incomingCall: P2PCall | null;
  /** iOS: the call CallKit is ringing right now. The in-app ring stays quiet for it. */
  systemRingingCallId: string | null;

  /** Local media stream (mic + optional camera) */
  localStream: MediaStream | null;

  /** Remote media stream (received via WebRTC ontrack) */
  remoteStream: MediaStream | null;

  /** Media engine for the current call — owns the connection, the mic and the camera. */
  engine: CallMediaEngine | null;
  /** The engine draws the video outside the page (iOS); the call screen leaves it a hole. */
  isNativeVideo: boolean;
  /** A picture from the peer to show; a remote track's `enabled` cannot say. Derived from below. */
  hasRemoteVideo: boolean;
  /** The engine sees a live, flowing remote video track. */
  remoteTrackVideo: boolean;
  /** The peer said it stopped putting a picture on that track. Stays false for a peer that
   * never says — an older client — so its track alone decides, as before. */
  peerVideoOff: boolean;
  /** Creates and wires the engine for this call if there is none yet. */
  _ensureEngine: () => CallMediaEngine | null;

  isMuted: boolean;
  isVideoOn: boolean;
  /** Which camera is publishing. Drives the mirror on your own preview. */
  cameraFacing: CameraFacing;
  /** A camera or screen change is in flight. One at a time: two in parallel raced each other. */
  _mediaChanging: boolean;
  /** What we last told the peer about our picture; null means tell it again. */
  _videoAnnounced: boolean | null;
  /** The call this device sent an accept for; only it may answer the caller's offer. */
  _acceptSentFor: string | null;
  /** How this device itself last ended a call; read by useCallKit once the call is gone. */
  _localEnd: LocalEnd | null;
  isScreenSharing: boolean;

  /** Remote audio output volume, 0–200 (100 = normal). Above 100 amplifies via Web Audio. */
  remoteVolume: number;
  setRemoteVolume: (volume: number) => void;

  /** Active call duration in seconds — incremented by timer */
  callDuration: number;
  _durationInterval: ReturnType<typeof setInterval> | null;

  /** This connection's id; the server names the winning session when two devices accept. */
  _sessionId: string | null;
  setSessionId: (id: string | null) => void;
  /** Calls ended here before the server heard; its re-delivery on connect must not ring again. */
  _endedHere: Record<string, EndedHere>;
  /** Ends for a call a previous page left running, waiting for a socket sender. */
  _orphanedEnds: OrphanedEnd[];
  /**
   * A call the previous page left running natively. This page cannot resume it; it hangs up in
   * the name of the page that ran it, the only app the server lets end an answered call.
   */
  endOrphanedCall: (callId: string, instanceId?: string) => void;
  /** A call the previous page left running with live media; this page asks to take it over. */
  _adoptCandidate: AdoptableCall | null;
  _adoptTimer: ReturnType<typeof setTimeout> | null;
  /** The adopted call, for useCallKit: it cannot know the call was on the system screen. */
  _adopted: { callId: string; inCallKit: boolean } | null;
  holdAdoptableCall: (call: AdoptableCall) => void;
  handleCallAdopted: (data: P2PCall) => void;
  /** The take-over failed or the call is gone: stop the native media and hang up. */
  abandonAdoption: () => void;

  // ─── WS Send ───

  /** Injected WS send callback (DI pattern from useWebSocket) */
  _sendWS: ((op: string, data?: unknown) => void) | null;
  registerSendWS: (fn: ((op: string, data?: unknown) => void) | null) => void;

  // ─── Actions ───

  initiateCall: (receiverId: string, callType: P2PCallType) => void;
  /** Reclaim a live call after the socket carrying it was replaced. */
  resumeCallAfterReconnect: () => void;
  acceptCall: (callId: string) => void;
  declineCall: (callId: string) => void;
  /** Declined on the system call screen before the call reached the app. */
  declineUnseenCall: (callId: string) => void;
  /** `how` is what the phone's call history records for this device's own end. */
  endCall: (how?: LocalEnd["how"]) => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  switchCamera: () => void;
  toggleScreenShare: () => void;
  startWebRTC: (isCaller: boolean) => Promise<void>;
  cleanup: () => void;

  // ─── WS Event Handlers ───

  handleCallInitiate: (data: P2PCall) => void;
  handleCallAccept: (data: { call_id: string; accepted_by?: string; accepted_by_instance?: string }) => void;
  handleCallDecline: (data: { call_id: string; reason?: string; declined_by?: string }) => void;
  handleCallEnd: (data: { call_id: string; reason?: string; ended_by?: string }) => void;
  handleCallBusy: (data: { receiver_id: string }) => void;
  handleSignal: (data: P2PSignalPayload) => void;
};

/** iOS runs native WebRTC: WKWebView gets no microphone while CallKit owns the session. */
function createEngine(events: CallEngineEvents): CallMediaEngine {
  if (getCapacitorPlatform() === "ios") {
    return new NativeCallEngine(events);
  }
  return new WebCallEngine(events);
}

// ─── Store ───

function rememberEnded(
  current: Record<string, EndedHere>,
  callId: string,
  op: EndedHere["op"],
): Record<string, EndedHere> {
  const now = Date.now();
  const next: Record<string, EndedHere> = {};
  for (const [id, entry] of Object.entries(current)) {
    if (entry.until > now) next[id] = entry;
  }
  next[callId] = { op, until: now + ENDED_HERE_TTL };
  return next;
}

/**
 * Whether a broadcast's "who did this" names another running app. The instance survives a
 * reconnect; the session does not, so this app's own accept from its old socket would otherwise
 * read as a stranger's. The session is the fallback for a server that sends no instance.
 */
function namesAnotherApp(session: string | undefined, instance: string | undefined, mySession: string | null): boolean {
  if (instance) return instance !== INSTANCE_ID;
  return session !== undefined && session !== mySession;
}

/** Media that fails to start ends the call on the server too, or the peer sits in a silent call. */
function endCallThatFailedToStart(callId: string, err: unknown): void {
  console.error("[p2p] WebRTC start error:", err);
  const store = useP2PCallStore.getState();
  if (store.activeCall?.id === callId) store.endCall("failed");
}

/** hasRemoteVideo is only ever written through this, so the two inputs cannot drift apart. */
function remoteVideo(
  current: Pick<P2PCallStore, "remoteTrackVideo" | "peerVideoOff">,
  patch: Partial<Pick<P2PCallStore, "remoteTrackVideo" | "peerVideoOff">>,
): Pick<P2PCallStore, "remoteTrackVideo" | "peerVideoOff" | "hasRemoteVideo"> {
  const next = { ...current, ...patch };
  return { ...next, hasRemoteVideo: next.remoteTrackVideo && !next.peerVideoOff };
}

export const useP2PCallStore = create<P2PCallStore>((set, get, api) => ({
  activeCall: null,
  incomingCall: null,
  systemRingingCallId: null,
  localStream: null,
  remoteStream: null,
  engine: null,
  isNativeVideo: false,
  hasRemoteVideo: false,
  remoteTrackVideo: false,
  peerVideoOff: false,
  isMuted: false,
  isVideoOn: false,
  cameraFacing: "front",
  _mediaChanging: false,
  _videoAnnounced: null,
  _acceptSentFor: null,
  _localEnd: null,
  isScreenSharing: false,
  remoteVolume: 100,
  callDuration: 0,
  _durationInterval: null,
  _sessionId: null,
  _endedHere: {},
  _orphanedEnds: [],
  _adoptCandidate: null,
  _adoptTimer: null,
  _adopted: null,
  _sendWS: null,

  setSessionId: (id) => set({ _sessionId: id }),

  registerSendWS: (fn) => {
    const pending = get()._orphanedEnds;
    if (!fn || pending.length === 0) {
      set({ _sendWS: fn });
      return;
    }
    set({ _sendWS: fn, _orphanedEnds: [] });
    for (const end of pending) fn("p2p_call_end", end);
  },

  holdAdoptableCall: (call) => {
    // Without the old page's instance the server cannot hand the call over; and once this page
    // has connected without claiming it, the server has already released it.
    if (!call.instanceId || get()._sessionId) {
      void NativeP2PCall.discardOrphanedCall().catch(() => {});
      get().endOrphanedCall(call.callId, call.instanceId);
      return;
    }
    set({ _adoptCandidate: call });
  },

  handleCallAdopted: (data) => {
    const { _adoptCandidate: candidate, _adoptTimer } = get();
    if (!candidate || candidate.callId !== data.id) return;
    if (_adoptTimer) clearTimeout(_adoptTimer);
    const acceptedAt = data.accepted_at ? Date.parse(data.accepted_at) : NaN;
    set({
      _adoptCandidate: null,
      _adoptTimer: null,
      _adopted: { callId: data.id, inCallKit: candidate.inCallKit },
      activeCall: { ...data, status: "active" },
      incomingCall: null,
      isMuted: !candidate.micEnabled,
      isVideoOn: candidate.videoEnabled,
      cameraFacing: candidate.facing,
      remoteVolume: candidate.volume,
      callDuration: Number.isFinite(acceptedAt) ? Math.max(0, Math.floor((Date.now() - acceptedAt) / 1000)) : 0,
      _durationInterval: setInterval(() => set((state) => ({ callDuration: state.callDuration + 1 })), 1000),
    });
    set(remoteVideo(get(), { remoteTrackVideo: candidate.remoteVideo }));

    const engine = get()._ensureEngine();
    if (engine instanceof NativeCallEngine) {
      void engine.adopt(candidate).then(() => engine.resync());
    }
    // What the peer's camera is doing was lost with the old page; ask, and say ours again.
    get()._sendWS?.("p2p_signal", { call_id: data.id, type: "video-query" });
    set({ _videoAnnounced: null });
  },

  abandonAdoption: () => {
    const { _adoptCandidate: candidate, _adoptTimer } = get();
    if (_adoptTimer) clearTimeout(_adoptTimer);
    set({ _adoptCandidate: null, _adoptTimer: null });
    if (!candidate) return;
    void NativeP2PCall.discardOrphanedCall().catch(() => {});
    get().endOrphanedCall(candidate.callId, candidate.instanceId);
  },

  endOrphanedCall: (callId, instanceId) => {
    const { _sendWS, _endedHere, _orphanedEnds } = get();
    const end: OrphanedEnd = instanceId ? { call_id: callId, instance_id: instanceId } : { call_id: callId };
    set({ _endedHere: rememberEnded(_endedHere, callId, "p2p_call_end") });
    if (_sendWS) _sendWS("p2p_call_end", end);
    else set({ _orphanedEnds: [..._orphanedEnds, end] });
  },

  setRemoteVolume: (volume) => {
    const remoteVolume = Math.max(0, Math.min(200, volume));
    set({ remoteVolume });
    get().engine?.setRemoteVolume(remoteVolume);
  },

  // ─── Actions ───

  initiateCall: (receiverId, callType) => {
    const { _sendWS } = get();
    if (!_sendWS) return;

    _sendWS("p2p_call_initiate", {
      receiver_id: receiverId,
      call_type: callType,
    });
  },

  // The socket carrying the call died and this one replaced it. Media is peer-to-peer and never
  // stopped — but the server scheduled a teardown when the old socket closed, and it identifies
  // the call by SESSION, which just changed. Claim it back, or it is hung up under us and the
  // ICE restart that would have recovered the media is rejected as coming from a stranger.
  resumeCallAfterReconnect: () => {
    const { _sendWS, activeCall, incomingCall, _acceptSentFor, _adoptCandidate, _adoptTimer } = get();
    if (!_sendWS) return;
    if (_adoptCandidate) {
      _sendWS("p2p_call_adopt", { call_id: _adoptCandidate.callId, instance_id: _adoptCandidate.instanceId });
      if (!_adoptTimer) set({ _adoptTimer: setTimeout(() => get().abandonAdoption(), ADOPT_WAIT_MS) });
    }
    // Every call on screen is asked about: the server rebinds it to this socket, or repeats the
    // end that went to the dead one (a ringing receiver has no timeout of its own).
    if (incomingCall && incomingCall.id !== activeCall?.id) {
      _sendWS("p2p_call_resume", { call_id: incomingCall.id });
    }
    if (!activeCall) return;
    // Answered, but the confirmation may have died with the old socket. The server takes this as
    // the answer if the call still rings, or hands this connection the call it already accepted.
    if (activeCall.status === "ringing" && _acceptSentFor === activeCall.id) {
      _sendWS("p2p_call_accept", { call_id: activeCall.id });
      return;
    }

    _sendWS("p2p_call_resume", { call_id: activeCall.id });
    if (activeCall.status !== "active") return;

    // Video announcements are not queued while the socket is down: ours may have been dropped on
    // the way out, and the peer's on the way in. Re-send ours and ask for theirs.
    _sendWS("p2p_signal", { call_id: activeCall.id, type: "video-query" });
    set({ _videoAnnounced: null });
    // Signals are not queued either: an offer or answer lost on the way leaves nobody negotiating.
    get().engine?.resync();
  },

  acceptCall: (callId) => {
    const { _sendWS, incomingCall } = get();
    if (!_sendWS || !incomingCall) return;

    set({ _acceptSentFor: callId });
    _sendWS("p2p_call_accept", { call_id: callId });
  },

  declineCall: (callId) => {
    const { _sendWS, _acceptSentFor, activeCall, _endedHere } = get();
    // Already answered: the server may hold the call as active, where a decline is refused and
    // the caller is left in a silent call. An end works on a ringing and an answered call alike.
    const op = _acceptSentFor === callId ? "p2p_call_end" : "p2p_call_decline";
    _sendWS?.(op, { call_id: callId });
    set({ _localEnd: { callId, how: "declined" }, _endedHere: rememberEnded(_endedHere, callId, op) });
    if (op === "p2p_call_decline") {
      set({ incomingCall: null, activeCall: null });
    } else if (activeCall?.id === callId) {
      get().cleanup();
    } else {
      set({ incomingCall: null, _acceptSentFor: null });
    }
  },

  declineUnseenCall: (callId) => {
    get()._sendWS?.("p2p_call_decline", { call_id: callId });
    set({ _endedHere: rememberEnded(get()._endedHere, callId, "p2p_call_decline") });
  },

  endCall: (how = "hungUp") => {
    const { _sendWS, activeCall, _endedHere } = get();
    if (activeCall) {
      set({
        _localEnd: { callId: activeCall.id, how },
        _endedHere: rememberEnded(_endedHere, activeCall.id, "p2p_call_end"),
      });
    }
    // Name the call: a late hang-up would otherwise end whatever call came after it.
    _sendWS?.("p2p_call_end", activeCall ? { call_id: activeCall.id } : undefined);
    // Local teardown even with no socket to tell the server: the microphone stops now.
    get().cleanup();
  },

  toggleMute: () => {
    const { engine, isMuted } = get();
    const next = !isMuted;
    engine?.setMicEnabled(!next);
    set({ isMuted: next });
  },

  toggleVideo: () => {
    const { engine, isVideoOn, _mediaChanging } = get();
    if (!engine || _mediaChanging) return;
    set({ _mediaChanging: true });
    // The engine reports the state it reached, so a denied camera cannot leave the button lit.
    void engine
      .setVideoEnabled(!isVideoOn)
      .catch(() => isVideoOn)
      .then((enabled) => {
        // A call that ended meanwhile has been reset; this result is not the next call's.
        if (get().engine !== engine) return;
        set({ _mediaChanging: false, isVideoOn: enabled });
      });
  },

  switchCamera: () => {
    const { engine, isVideoOn, _mediaChanging } = get();
    if (!engine || !isVideoOn || _mediaChanging) return;
    set({ _mediaChanging: true });
    // The engine reports where it landed; a phone with one camera stays where it was.
    void engine.switchCamera().catch(() => null).then((facing) => {
      // A call that ended meanwhile has been reset; nothing of this switch belongs to it.
      if (get().engine !== engine) return;
      set({ _mediaChanging: false, ...(facing ? { cameraFacing: facing } : {}) });
    });
  },

  toggleScreenShare: () => {
    const { engine, isScreenSharing, _mediaChanging } = get();
    if (!engine) return;
    // Stopping is immediate and always safe, so it is never held back.
    if (isScreenSharing) {
      engine.stopScreenShare();
      set({ isScreenSharing: false });
      return;
    }
    if (_mediaChanging) return;
    set({ _mediaChanging: true });
    void engine
      .startScreenShare()
      .catch(() => false)
      .then((started) => {
        if (get().engine !== engine) return;
        set({ _mediaChanging: false, isScreenSharing: started });
      });
  },

  _ensureEngine: () => {
    const existing = get().engine;
    if (existing) return existing;

    const activeCall = get().activeCall;
    if (!activeCall) return null;
    const callId = activeCall.id;

    // Every callback re-checks the call: a late event from an engine whose call has ended
    // must not signal into, or mutate, the call that replaced it.
    const isCurrentCall = () => get().activeCall?.id === callId;
    const signal = (payload: Record<string, unknown>) => {
      if (!isCurrentCall()) return;
      get()._sendWS?.("p2p_signal", { call_id: callId, ...payload });
    };

    const engine = createEngine({
      onLocalDescription: (desc) => signal({ type: desc.type, sdp: desc.sdp }),
      onIceCandidate: (candidate) => signal({ type: "ice-candidate", candidate }),
      onIceRestartNeeded: () => signal({ type: "ice-restart" }),
      onLocalStream: (stream) => {
        if (!isCurrentCall()) return;
        set({ localStream: stream });
        // Android 14+ refuses a microphone foreground service unless the mic is already in
        // use, so this waits for the stream instead of firing on accept.
        if (stream) startVoiceCallService("p2p");
      },
      onRemoteStream: (stream) => {
        if (isCurrentCall()) set({ remoteStream: stream });
      },
      onRemoteVideo: (available) => {
        if (isCurrentCall()) set(remoteVideo(get(), { remoteTrackVideo: available }));
      },
      onLocalVideo: (available) => {
        if (isCurrentCall()) set({ isVideoOn: available });
      },
      onScreenShareEnded: () => {
        if (isCurrentCall()) set({ isScreenSharing: false });
      },
      onConnectionLost: () => {
        if (isCurrentCall()) get().endCall("failed");
      },
    });

    set({ engine, isNativeVideo: engine.rendersVideoNatively });

    // The call can be muted before it has an engine — from the CallKit screen, before the
    // accept has come back. That mute lives only in isMuted until now.
    if (get().isMuted) engine.setMicEnabled(false);

    // Tell the peer whenever our picture starts or stops, from the state rather than each
    // toggle. Lives as long as this engine; clearing _videoAnnounced makes it say it again.
    const unsubscribe = api.subscribe((state) => {
      if (!isCurrentCall() || state.engine !== engine) {
        unsubscribe();
        return;
      }
      const sending = state.isVideoOn || state.isScreenSharing;
      if (sending === state._videoAnnounced) return;
      set({ _videoAnnounced: sending });
      signal({ type: sending ? "video-on" : "video-off" });
    });

    return engine;
  },

  startWebRTC: async (isCaller) => {
    const { activeCall, _sendWS } = get();
    if (!activeCall || !_sendWS) return;
    const callId = activeCall.id;

    const engine = get()._ensureEngine();
    if (!engine) return;

    try {
      await engine.start({ callId, callType: activeCall.call_type, isCaller });
    } catch (err) {
      endCallThatFailedToStart(callId, err);
    }
  },

  cleanup: () => {
    const { engine, _durationInterval } = get();

    // Release the mic foreground service this call may have started. The "p2p" holder is
    // idempotent, so a ringing/declined call that never started it is a no-op, and an overlapping
    // channel-voice call keeps its own "voice" hold.
    stopVoiceCallService("p2p");

    // The engine owns the connection and every track it opened, including a screen-share
    // track that never belonged to the local stream.
    engine?.close();

    if (_durationInterval) {
      clearInterval(_durationInterval);
    }

    set({
      activeCall: null,
      incomingCall: null,
      localStream: null,
      remoteStream: null,
      engine: null,
      isNativeVideo: false,
      hasRemoteVideo: false,
      remoteTrackVideo: false,
      peerVideoOff: false,
      isMuted: false,
      isVideoOn: false,
      cameraFacing: "front",
      _mediaChanging: false,
      _videoAnnounced: null,
      _acceptSentFor: null,
      isScreenSharing: false,
      remoteVolume: 100,
      callDuration: 0,
      _durationInterval: null,
    });
  },

  // ─── WS Event Handlers ───

  handleCallInitiate: (data) => {
    const { activeCall, _sessionId, _endedHere } = get();

    // Ended here while the server had not heard yet; its re-delivery must not ring again.
    const ended = _endedHere[data.id];
    if (ended && ended.until > Date.now()) {
      get()._sendWS?.(ended.op, { call_id: data.id });
      return;
    }

    // The caller's OTHER devices see the outgoing call too. It is not theirs: taking it would
    // flip them to active on accept, open a microphone, and send a second SDP offer for the
    // same call. The server names the session that dialled.
    const userId = useAuthStore.getState().user?.id;
    const isCaller = data.caller_id === userId;
    if (isCaller && namesAnotherApp(data.initiated_by, data.initiated_by_instance, _sessionId)) {
      return;
    }

    if (activeCall) {
      // Already in a call — show as incoming call overlay
      set({ incomingCall: data });
    } else {
      // Both caller and receiver get this event.
      // Component layer decides role based on callerId vs current userId.
      set({ activeCall: data, incomingCall: data });
    }
  },

  handleCallAccept: (data) => {
    const { activeCall, _sessionId, _adoptCandidate } = get();
    // The take-over was refused: another app holds the call.
    if (_adoptCandidate?.callId === data.call_id) {
      get().abandonAdoption();
      return;
    }
    if (!activeCall || activeCall.id !== data.call_id) return;
    // A repeated accept started a second duration timer and leaked the first.
    if (activeCall.status === "active") return;

    const userId = useAuthStore.getState().user?.id;
    const isCaller = activeCall.caller_id === userId;

    // The server broadcasts the accept to every one of the receiver's sessions and names
    // the one that took the call. On the others, drop it: falling through would flip them
    // to "active" and start WebRTC, and since signalling is user-wide too they would
    // answer the caller's offer alongside the device that really answered.
    if (!isCaller && namesAnotherApp(data.accepted_by, data.accepted_by_instance, _sessionId)) {
      dismissIncomingCallUI(data.call_id, "answeredElsewhere");
      get().cleanup();
      return;
    }

    set({
      activeCall: { ...activeCall, status: "active" },
      incomingCall: null,
    });

    // Start duration timer
    const interval = setInterval(() => {
      set((state) => ({ callDuration: state.callDuration + 1 }));
    }, 1000);
    set({ _durationInterval: interval });

    // handleCallAccept fires on both sides.
    // Caller starts WebRTC via startWebRTC(true), receiver via startWebRTC(false).
    // Role determination happens at the component level (userId comparison).
  },

  handleCallDecline: (data) => {
    const { activeCall, incomingCall } = get();
    const t = i18n.t.bind(i18n);
    // Declined on another of our own devices — tear down quietly. The "call declined"
    // toast is for the other party, not for ourselves.
    const declinedBySelf = data.declined_by === useAuthStore.getState().user?.id;

    if (activeCall && activeCall.id === data.call_id) {
      if (declinedBySelf) dismissIncomingCallUI(data.call_id, "declinedElsewhere");
      else useToastStore.getState().addToast("info", t("common:callDeclined"));
      get().cleanup();
      return;
    }

    if (incomingCall && incomingCall.id === data.call_id) {
      if (declinedBySelf) dismissIncomingCallUI(data.call_id, "declinedElsewhere");
      set({ incomingCall: null });
    }
  },

  handleCallEnd: (data) => {
    const { activeCall, incomingCall, _adoptCandidate } = get();
    if (_adoptCandidate?.callId === data.call_id) {
      get().abandonAdoption();
      return;
    }
    const reason = data.reason === "timeout" ? "unanswered" : data.reason === "disconnect" ? "failed" : "remoteEnded";
    // A delayed end for a call we already left must not tear down the current
    // one. Only clean up when it matches; otherwise at most drop a stale incoming.
    if (activeCall && activeCall.id === data.call_id) {
      dismissIncomingCallUI(data.call_id, reason);
      get().cleanup();
      return;
    }
    if (incomingCall && incomingCall.id === data.call_id) {
      dismissIncomingCallUI(data.call_id, reason);
      set({ incomingCall: null });
    }
  },

  handleCallBusy: (data) => {
    const t = i18n.t.bind(i18n);
    useToastStore.getState().addToast("warning", t("common:userBusy"));
    // Only tear down an outgoing/ringing attempt to THIS receiver — a stale busy
    // for a prior attempt must never close an unrelated active call.
    const { activeCall } = get();
    if (activeCall && activeCall.status !== "active" && activeCall.receiver_id === data.receiver_id) {
      get().cleanup();
    }
  },

  handleSignal: async (data) => {
    const { activeCall } = get();

    // Ignore signals that do not belong to the current call — a delayed offer, answer or
    // candidate from a previous call must not drive negotiation for the one in progress.
    if (!activeCall || data.call_id !== activeCall.id) return;
    const callId = activeCall.id;

    // The dispatcher does not await this handler, so a rejection from the engine would be an
    // unhandled rejection — contain it here.
    try {
      switch (data.type) {
        case "offer": {
          if (!data.sdp) break;
          let engine = get().engine;
          if (!engine) {
            // A sibling device that missed the accept is still ringing and must not answer: it
            // would open its microphone for a call another device took.
            if (activeCall.status !== "active" && get()._acceptSentFor !== callId) break;
            // The offer beat the accept handler. Only the receiver can be here; the caller
            // offers from startWebRTC.
            engine = get()._ensureEngine();
            if (!engine) break;
            try {
              await engine.start({ callId, callType: activeCall.call_type, isCaller: false });
            } catch (err) {
              endCallThatFailedToStart(callId, err);
              break;
            }
            if (get().activeCall?.id !== callId) break;
          }
          await engine.acceptRemoteOffer(data.sdp);
          break;
        }

        case "answer": {
          if (!data.sdp) break;
          await get().engine?.acceptRemoteAnswer(data.sdp);
          break;
        }

        case "ice-candidate": {
          if (!data.candidate) break;
          await get().engine?.addIceCandidate(data.candidate);
          break;
        }

        case "ice-restart": {
          // The peer asked for an ICE restart; our bounded recovery handles it on either side.
          get().engine?.restartIce();
          break;
        }

        case "video-on":
        case "video-off": {
          set(remoteVideo(get(), { peerVideoOff: data.type === "video-off" }));
          break;
        }

        case "video-query": {
          set({ _videoAnnounced: null });
          break;
        }
      }
    } catch (err) {
      console.error("[p2p] handleSignal error:", err);
    }
  },
}));

registerP2PCallControl({
  hasLiveMedia: () => useP2PCallStore.getState().activeCall?.status === "active",
  hasCall: () => useP2PCallStore.getState().activeCall !== null,
  end: () => useP2PCallStore.getState().endCall(),
  leave: () => {
    const { activeCall, _acceptSentFor, endCall, cleanup } = useP2PCallStore.getState();
    // Signing out of one device is not declining: the user's other devices keep ringing.
    const unanswered =
      activeCall?.status === "ringing" &&
      activeCall.receiver_id === useAuthStore.getState().user?.id &&
      _acceptSentFor !== activeCall.id;
    if (unanswered) cleanup();
    else endCall();
  },
});
