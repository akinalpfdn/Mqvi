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
import type { CallEngineEvents, CallMediaEngine } from "../call/CallMediaEngine";
import { NativeCallEngine } from "../call/NativeCallEngine";
import { WebCallEngine } from "../call/WebCallEngine";
import { getCapacitorPlatform } from "../utils/constants";
import { dismissIncomingCallUI } from "../native/p2pCall";
import { startVoiceCallService, stopVoiceCallService } from "../utils/nativePlugins";
import type { P2PCall, P2PCallType, P2PSignalPayload } from "../types";
import { useAuthStore } from "./authStore";
import { useToastStore } from "./toastStore";

// ─── Types ───

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
  /** Whether the peer is sending video. On a natively drawn call there is no stream to ask. */
  hasRemoteVideo: boolean;
  /** Creates and wires the engine for this call if there is none yet. */
  _ensureEngine: () => CallMediaEngine | null;

  isMuted: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;

  /** Remote audio output volume, 0–200 (100 = normal). Above 100 amplifies via Web Audio. */
  remoteVolume: number;
  setRemoteVolume: (volume: number) => void;

  /** Active call duration in seconds — incremented by timer */
  callDuration: number;
  _durationInterval: ReturnType<typeof setInterval> | null;

  /**
   * This connection's id, from the ready event. p2p_call_accept is broadcast to every
   * session the receiver has and names the one that won, so each device can tell whether
   * it is the one joining the call. Assuming "I sent the accept, so I won" would be wrong:
   * two devices can accept at once and the server picks one.
   */
  _sessionId: string | null;
  setSessionId: (id: string | null) => void;

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
  endCall: () => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  startWebRTC: (isCaller: boolean) => Promise<void>;
  cleanup: () => void;

  // ─── WS Event Handlers ───

  handleCallInitiate: (data: P2PCall) => void;
  handleCallAccept: (data: { call_id: string; accepted_by?: string }) => void;
  handleCallDecline: (data: { call_id: string; reason?: string; declined_by?: string }) => void;
  handleCallEnd: (data: { call_id: string; reason?: string; ended_by?: string }) => void;
  handleCallBusy: (data: { receiver_id: string }) => void;
  handleSignal: (data: P2PSignalPayload) => void;
};

/**
 * The engine that runs a call's media.
 *
 * iOS runs natively, audio and video: WKWebView cannot capture the microphone while CallKit
 * owns the audio session, which is why a call answered from the system screen connected and
 * then stayed silent in both directions. The video is drawn by the native layer over the web
 * view, since a native track cannot be handed to a page element.
 */
function createEngine(events: CallEngineEvents): CallMediaEngine {
  if (getCapacitorPlatform() === "ios") {
    return new NativeCallEngine(events);
  }
  return new WebCallEngine(events);
}

// ─── Store ───

export const useP2PCallStore = create<P2PCallStore>((set, get) => ({
  activeCall: null,
  incomingCall: null,
  systemRingingCallId: null,
  localStream: null,
  remoteStream: null,
  engine: null,
  isNativeVideo: false,
  hasRemoteVideo: false,
  isMuted: false,
  isVideoOn: false,
  isScreenSharing: false,
  remoteVolume: 100,
  callDuration: 0,
  _durationInterval: null,
  _sessionId: null,
  _sendWS: null,

  setSessionId: (id) => set({ _sessionId: id }),

  registerSendWS: (fn) => set({ _sendWS: fn }),

  setRemoteVolume: (volume) => set({ remoteVolume: Math.max(0, Math.min(200, volume)) }),

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
    const { _sendWS, activeCall } = get();
    if (!_sendWS || !activeCall || activeCall.status !== "active") return;

    _sendWS("p2p_call_resume", { call_id: activeCall.id });
  },

  acceptCall: (callId) => {
    const { _sendWS, incomingCall } = get();
    if (!_sendWS || !incomingCall) return;

    _sendWS("p2p_call_accept", { call_id: callId });
  },

  declineCall: (callId) => {
    const { _sendWS } = get();
    if (!_sendWS) return;

    _sendWS("p2p_call_decline", { call_id: callId });
    set({ incomingCall: null, activeCall: null });
  },

  endCall: () => {
    const { _sendWS, activeCall } = get();
    if (!_sendWS) return;

    // Name the call. A late hang-up — from a sibling device, or from the 30s outgoing timeout —
    // would otherwise end whatever call the user has started since.
    _sendWS("p2p_call_end", activeCall ? { call_id: activeCall.id } : undefined);
    get().cleanup();
  },

  toggleMute: () => {
    const { engine, isMuted } = get();
    const next = !isMuted;
    engine?.setMicEnabled(!next);
    set({ isMuted: next });
  },

  toggleVideo: () => {
    const { engine, isVideoOn } = get();
    if (!engine) return;
    // The engine reports the state it actually reached, so a denied camera cannot leave the
    // button lit.
    void engine.setVideoEnabled(!isVideoOn).then((enabled) => set({ isVideoOn: enabled }));
  },

  toggleScreenShare: () => {
    const { engine, isScreenSharing } = get();
    if (!engine) return;
    if (isScreenSharing) {
      engine.stopScreenShare();
      set({ isScreenSharing: false });
      return;
    }
    void engine.startScreenShare().then((started) => set({ isScreenSharing: started }));
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
        set({ localStream: stream, isVideoOn: activeCall.call_type === "video" });
        // Android 14+ refuses a microphone foreground service unless the mic is already in
        // use, so this waits for the stream instead of firing on accept.
        if (stream) startVoiceCallService("p2p");
      },
      onRemoteStream: (stream) => {
        if (isCurrentCall()) set({ remoteStream: stream });
      },
      onRemoteVideo: (available) => {
        if (isCurrentCall()) set({ hasRemoteVideo: available });
      },
      onScreenShareEnded: () => {
        if (isCurrentCall()) set({ isScreenSharing: false });
      },
      onConnectionLost: () => {
        if (isCurrentCall()) get().endCall();
      },
    });

    set({ engine, isNativeVideo: engine.rendersVideoNatively });
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
      console.error("[p2p] WebRTC start error:", err);
      // Only tear down if still on the same call — a late failure from a call the user has
      // already left must not clean up the new one.
      if (get().activeCall?.id === callId) get().cleanup();
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
      isMuted: false,
      isVideoOn: false,
      isScreenSharing: false,
      remoteVolume: 100,
      callDuration: 0,
      _durationInterval: null,
    });
  },

  // ─── WS Event Handlers ───

  handleCallInitiate: (data) => {
    const { activeCall, _sessionId } = get();

    // The caller's OTHER devices see the outgoing call too. It is not theirs: taking it would
    // flip them to active on accept, open a microphone, and send a second SDP offer for the
    // same call. The server names the session that dialled.
    const userId = useAuthStore.getState().user?.id;
    const isCaller = data.caller_id === userId;
    if (isCaller && data.initiated_by !== undefined && data.initiated_by !== _sessionId) {
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
    const { activeCall, _sessionId } = get();
    if (!activeCall || activeCall.id !== data.call_id) return;

    const userId = useAuthStore.getState().user?.id;
    const isCaller = activeCall.caller_id === userId;

    // The server broadcasts the accept to every one of the receiver's sessions and names
    // the one that took the call. On the others, drop it: falling through would flip them
    // to "active" and start WebRTC, and since signalling is user-wide too they would
    // answer the caller's offer alongside the device that really answered.
    if (!isCaller && data.accepted_by !== undefined && data.accepted_by !== _sessionId) {
      dismissIncomingCallUI(data.call_id);
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
      if (declinedBySelf) dismissIncomingCallUI(data.call_id);
      else useToastStore.getState().addToast("info", t("common:callDeclined"));
      get().cleanup();
      return;
    }

    if (incomingCall && incomingCall.id === data.call_id) {
      if (declinedBySelf) dismissIncomingCallUI(data.call_id);
      set({ incomingCall: null });
    }
  },

  handleCallEnd: (data) => {
    const { activeCall, incomingCall } = get();
    // A delayed end for a call we already left must not tear down the current
    // one. Only clean up when it matches; otherwise at most drop a stale incoming.
    if (activeCall && activeCall.id === data.call_id) {
      dismissIncomingCallUI(data.call_id);
      get().cleanup();
      return;
    }
    if (incomingCall && incomingCall.id === data.call_id) {
      dismissIncomingCallUI(data.call_id);
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
            // The offer beat the accept handler. Only the receiver can be here; the caller
            // offers from startWebRTC.
            engine = get()._ensureEngine();
            if (!engine) break;
            await engine.start({ callId, callType: activeCall.call_type, isCaller: false });
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
          // The peer detected a failure and asked us to restart ICE. Only the offerer can do
          // it; on the answerer the engine treats it as a no-op, and it is idempotent while a
          // recovery is already running.
          get().engine?.restartIce();
          break;
        }
      }
    } catch (err) {
      console.error("[p2p] handleSignal error:", err);
    }
  },
}));
