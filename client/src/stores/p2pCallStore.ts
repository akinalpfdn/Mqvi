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
import type { P2PCall, P2PCallType, P2PSignalPayload } from "../types";
import { useToastStore } from "./toastStore";

// ─── STUN Configuration ───

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// ─── Types ───

type P2PCallStore = {
  /** Active call (ringing or active) — null means not in a call */
  activeCall: P2PCall | null;

  /** Incoming call notification — used by IncomingCallOverlay */
  incomingCall: P2PCall | null;

  /** Local media stream (mic + optional camera) */
  localStream: MediaStream | null;

  /** Remote media stream (received via WebRTC ontrack) */
  remoteStream: MediaStream | null;

  /** WebRTC peer connection instance */
  peerConnection: RTCPeerConnection | null;

  /**
   * ICE candidate queue — buffers candidates arriving before remote description is set.
   * Flushed after setRemoteDescription completes.
   */
  _pendingCandidates: RTCIceCandidateInit[];

  isMuted: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;

  /** Active call duration in seconds — incremented by timer */
  callDuration: number;
  _durationInterval: ReturnType<typeof setInterval> | null;

  // ─── WS Send ───

  /** Injected WS send callback (DI pattern from useWebSocket) */
  _sendWS: ((op: string, data?: unknown) => void) | null;
  registerSendWS: (fn: ((op: string, data?: unknown) => void) | null) => void;

  // ─── Actions ───

  initiateCall: (receiverId: string, callType: P2PCallType) => void;
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
  handleCallAccept: (data: { call_id: string }) => void;
  handleCallDecline: (data: { call_id: string; reason?: string }) => void;
  handleCallEnd: (data: { call_id: string; reason?: string }) => void;
  handleCallBusy: (data: { receiver_id: string }) => void;
  handleSignal: (data: P2PSignalPayload) => void;
};

// ─── Helper: getUserMedia ───

async function getMediaStream(callType: P2PCallType): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: callType === "video"
      ? {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        }
      : false,
  });
}

// ─── Degradation Preference ───

/** Sets "balanced" degradation on video senders — both FPS and resolution degrade proportionally. */
function applyDegradationPreference(pc: RTCPeerConnection): void {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;

    const params = sender.getParameters();
    params.degradationPreference = "balanced";
    sender.setParameters(params).catch((err) => {
      console.warn("[p2p] Failed to set degradationPreference:", err);
    });
  }
}

// ─── PeerConnection Factory ───

/**
 * Creates RTCPeerConnection with standard handlers.
 * Single creation point prevents race conditions from duplicate PC creation.
 */
function createPeerConnection(
  activeCall: P2PCall,
  sendWS: (op: string, data?: unknown) => void,
  set: (partial: Partial<P2PCallStore> | ((state: P2PCallStore) => Partial<P2PCallStore>)) => void,
  get: () => P2PCallStore,
): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Relay new ICE candidates to the other peer
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWS("p2p_signal", {
        call_id: activeCall.id,
        type: "ice-candidate",
        candidate: event.candidate.toJSON(),
      });
    }
  };

  // Handle remote media tracks.
  // event.streams[0] may be empty for mid-call addTransceiver (screen share) —
  // in that case, add the track to existing remoteStream to preserve audio.
  pc.ontrack = (event) => {
    if (event.streams[0]) {
      set({ remoteStream: event.streams[0] });
    } else {
      const existing = get().remoteStream;
      const stream = new MediaStream(existing ? existing.getTracks() : []);
      stream.addTrack(event.track);
      set({ remoteStream: stream });
    }
  };

  // Connection state monitoring — end call on permanent failure.
  // "disconnected" may be transient (renegotiation, network change) so we wait before ending.
  let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }
      return;
    }

    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }
      console.warn("[p2p] PeerConnection state:", pc.connectionState);
      const current = get();
      if (current.activeCall) {
        current.endCall();
      }
    } else if (pc.connectionState === "disconnected") {
      // During renegotiation (signalingState !== "stable"), ICE may temporarily disconnect.
      const timeout = pc.signalingState !== "stable" ? 10000 : 5000;
      console.warn("[p2p] PeerConnection disconnected, waiting for recovery...", { signalingState: pc.signalingState, timeout });
      if (!disconnectedTimer) {
        disconnectedTimer = setTimeout(() => {
          disconnectedTimer = null;
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            console.warn("[p2p] PeerConnection did not recover, ending call");
            const current = get();
            if (current.activeCall) {
              current.endCall();
            }
          }
        }, timeout);
      }
    }
  };

  // onnegotiationneeded — auto offer creation after addTrack.
  // makingOffer flag and signalingState guard prevent glare (simultaneous offers)
  // and m-line order inconsistency. This is the sole offer creation point for
  // both initial offers and mid-call renegotiation.
  let makingOffer = false;
  pc.onnegotiationneeded = async () => {
    if (makingOffer || pc.signalingState !== "stable") return;
    try {
      makingOffer = true;
      const call = get().activeCall;
      if (!call) return;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendWS("p2p_signal", {
        call_id: call.id,
        type: "offer",
        sdp: offer.sdp,
      });
    } catch (err) {
      console.error("[p2p] Renegotiation error:", err);
    } finally {
      makingOffer = false;
    }
  };

  return pc;
}

// ─── Store ───

export const useP2PCallStore = create<P2PCallStore>((set, get) => ({
  activeCall: null,
  incomingCall: null,
  localStream: null,
  remoteStream: null,
  peerConnection: null,
  isMuted: false,
  isVideoOn: false,
  isScreenSharing: false,
  callDuration: 0,
  _durationInterval: null,
  _pendingCandidates: [],
  _sendWS: null,

  registerSendWS: (fn) => set({ _sendWS: fn }),

  // ─── Actions ───

  initiateCall: (receiverId, callType) => {
    const { _sendWS } = get();
    if (!_sendWS) return;

    _sendWS("p2p_call_initiate", {
      receiver_id: receiverId,
      call_type: callType,
    });
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
    const { _sendWS } = get();
    if (!_sendWS) return;

    _sendWS("p2p_call_end");
    get().cleanup();
  },

  toggleMute: () => {
    const { localStream, isMuted } = get();
    if (localStream) {
      for (const track of localStream.getAudioTracks()) {
        track.enabled = isMuted;
      }
    }
    set({ isMuted: !isMuted });
  },

  toggleVideo: () => {
    const { localStream, isVideoOn, peerConnection, activeCall } = get();
    if (!localStream || !peerConnection || !activeCall) return;

    if (isVideoOn) {
      for (const track of localStream.getVideoTracks()) {
        track.enabled = false;
      }
      set({ isVideoOn: false });
    } else {
      const existingVideoTrack = localStream.getVideoTracks()[0];
      if (existingVideoTrack) {
        existingVideoTrack.enabled = true;
        set({ isVideoOn: true });
      } else {
        // Acquire new video track — addTrack triggers onnegotiationneeded for auto renegotiation.
        navigator.mediaDevices
          .getUserMedia({
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: 30 },
            },
          })
          .then((videoStream) => {
            const videoTrack = videoStream.getVideoTracks()[0];
            localStream.addTrack(videoTrack);
            peerConnection.addTrack(videoTrack, localStream);
            set({ isVideoOn: true });
          })
          .catch((err) => {
            console.error("[p2p] Failed to get video:", err);
          });
      }
    }
  },

  toggleScreenShare: () => {
    const { isScreenSharing, peerConnection, localStream, activeCall } = get();
    if (!peerConnection || !activeCall || !localStream) return;

    if (isScreenSharing) {
      // Stop screen share — replace screen track with camera track or null
      const screenSender = (peerConnection as RTCPeerConnection & { _screenSender?: RTCRtpSender })._screenSender;

      if (screenSender) {
        const cameraTrack = localStream.getVideoTracks()[0];
        screenSender.replaceTrack(cameraTrack ?? null).catch(() => {});
        (peerConnection as RTCPeerConnection & { _screenSender?: RTCRtpSender })._screenSender = undefined;
      }

      set({ isScreenSharing: false });
    } else {
      // Start screen share.
      // If a video sender exists, use replaceTrack (no renegotiation needed).
      // Otherwise (voice-only call), add a sendonly video transceiver first —
      // addTransceiver triggers onnegotiationneeded for auto renegotiation.
      navigator.mediaDevices
        .getDisplayMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 60 },
          },
        })
        .then(async (screenStream) => {
          const screenTrack = screenStream.getVideoTracks()[0];
          const pc = get().peerConnection;
          if (!pc) {
            screenTrack.stop();
            return;
          }

          const senders = pc.getSenders();
          let videoSender = senders.find((s) => s.track?.kind === "video");

          if (!videoSender) {
            // Voice-only call — add video transceiver, wait for renegotiation to complete.
            // Two-phase wait: first wait for renegotiation to start (state leaves "stable"),
            // then wait for it to finish (state returns to "stable").
            const transceiver = pc.addTransceiver("video", { direction: "sendrecv" });
            videoSender = transceiver.sender;

            await new Promise<void>((resolve) => {
              const waitForStart = () => {
                if (pc.signalingState !== "stable") {
                  const waitForEnd = () => {
                    if (pc.signalingState === "stable") {
                      resolve();
                    } else {
                      setTimeout(waitForEnd, 50);
                    }
                  };
                  waitForEnd();
                } else {
                  setTimeout(waitForStart, 20);
                }
              };
              setTimeout(waitForStart, 20);
            });
          }

          await videoSender.replaceTrack(screenTrack);

          const screenParams = videoSender.getParameters();
          screenParams.degradationPreference = "balanced";
          await videoSender.setParameters(screenParams).catch(() => {});

          // Store sender reference for stop
          (pc as RTCPeerConnection & { _screenSender?: RTCRtpSender })._screenSender = videoSender;

          // Handle browser native "stop sharing" button
          screenTrack.onended = () => {
            const current = get();
            if (!current.isScreenSharing) return;

            const sender = (current.peerConnection as RTCPeerConnection & { _screenSender?: RTCRtpSender })?._screenSender;
            if (sender && current.localStream) {
              const cam = current.localStream.getVideoTracks()[0];
              sender.replaceTrack(cam ?? null).catch(() => {});
            }
            if (current.peerConnection) {
              (current.peerConnection as RTCPeerConnection & { _screenSender?: RTCRtpSender })._screenSender = undefined;
            }
            set({ isScreenSharing: false });
          };

          set({ isScreenSharing: true });
        })
        .catch((err) => {
          console.error("[p2p] Screen share error:", err);
        });
    }
  },

  startWebRTC: async (isCaller) => {
    const { activeCall, _sendWS } = get();
    if (!activeCall || !_sendWS) return;

    try {
      // Receiver defers stream acquisition to handleSignal("offer") to avoid
      // race condition with concurrent getUserMedia calls.
      if (!isCaller) {
        return;
      }

      const stream = await getMediaStream(activeCall.call_type);
      set({
        localStream: stream,
        isVideoOn: activeCall.call_type === "video",
      });

      const pc = createPeerConnection(activeCall, _sendWS, set, get);

      // addTrack triggers onnegotiationneeded -> handler auto-creates offer.
      // No explicit createOffer here to avoid duplicate offers.
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }

      applyDegradationPreference(pc);
      set({ peerConnection: pc });
    } catch (err) {
      console.error("[p2p] WebRTC start error:", err);
      get().cleanup();
    }
  },

  cleanup: () => {
    const { localStream, remoteStream, peerConnection, _durationInterval } = get();

    // Stop all sender/receiver tracks (includes screen share tracks not in localStream)
    if (peerConnection) {
      for (const sender of peerConnection.getSenders()) {
        if (sender.track) sender.track.stop();
      }
      for (const receiver of peerConnection.getReceivers()) {
        if (receiver.track) receiver.track.stop();
      }
    }

    // Safety net — stop remaining tracks on local/remote streams
    if (localStream) {
      for (const track of localStream.getTracks()) {
        track.stop();
      }
    }
    if (remoteStream) {
      for (const track of remoteStream.getTracks()) {
        track.stop();
      }
    }

    if (peerConnection) {
      peerConnection.close();
    }

    if (_durationInterval) {
      clearInterval(_durationInterval);
    }

    set({
      activeCall: null,
      incomingCall: null,
      localStream: null,
      remoteStream: null,
      peerConnection: null,
      isMuted: false,
      isVideoOn: false,
      isScreenSharing: false,
      callDuration: 0,
      _durationInterval: null,
      _pendingCandidates: [],
    });
  },

  // ─── WS Event Handlers ───

  handleCallInitiate: (data) => {
    const { activeCall } = get();

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
    const { activeCall } = get();
    if (!activeCall || activeCall.id !== data.call_id) return;

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

    if (activeCall && activeCall.id === data.call_id) {
      useToastStore.getState().addToast("info", t("common:callDeclined"));
      get().cleanup();
      return;
    }

    if (incomingCall && incomingCall.id === data.call_id) {
      set({ incomingCall: null });
    }
  },

  handleCallEnd: () => {
    get().cleanup();
  },

  handleCallBusy: () => {
    const t = i18n.t.bind(i18n);
    useToastStore.getState().addToast("warning", t("common:userBusy"));
    get().cleanup();
  },

  handleSignal: async (data) => {
    const { peerConnection, activeCall, _sendWS } = get();

    switch (data.type) {
      case "offer": {
        // Two scenarios:
        // A) Initial offer (new call): PC doesn't exist — create it, add local tracks, send answer.
        // B) Renegotiation (mid-call): PC exists — set new remote description, send new answer.

        let pc = peerConnection;

        if (!pc) {
          if (!activeCall || !_sendWS) break;

          pc = createPeerConnection(activeCall, _sendWS, set, get);

          // addTrack fires onnegotiationneeded async, but setRemoteDescription
          // synchronously changes signalingState to "have-remote-offer" —
          // the onnegotiationneeded guard prevents glare.
          let stream = get().localStream;
          if (!stream) {
            try {
              stream = await getMediaStream(activeCall.call_type);
              set({ localStream: stream, isVideoOn: activeCall.call_type === "video" });
            } catch (err) {
              console.error("[p2p] Failed to get media in handleSignal:", err);
            }
          }

          if (stream) {
            for (const track of stream.getTracks()) {
              pc.addTrack(track, stream);
            }
          }

          applyDegradationPreference(pc);
          set({ peerConnection: pc });
        }

        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: "offer", sdp: data.sdp })
        );

        // Flush queued ICE candidates
        const pendingOffer = get()._pendingCandidates;
        if (pendingOffer.length > 0) {
          set({ _pendingCandidates: [] });
          for (const c of pendingOffer) {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          }
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const call = get().activeCall;
        const ws = get()._sendWS;
        if (ws && call) {
          ws("p2p_signal", {
            call_id: call.id,
            type: "answer",
            sdp: answer.sdp,
          });
        }
        break;
      }

      case "answer": {
        // In glare or renegotiation race conditions, a late answer may arrive
        // when state is already "stable" — try-catch handles this safely.
        if (!peerConnection) return;
        try {
          await peerConnection.setRemoteDescription(
            new RTCSessionDescription({ type: "answer", sdp: data.sdp })
          );
        } catch (err) {
          console.warn("[p2p] Could not set remote answer (state:", peerConnection.signalingState, "):", err);
          break;
        }

        // Flush queued ICE candidates
        const pendingAnswer = get()._pendingCandidates;
        if (pendingAnswer.length > 0) {
          set({ _pendingCandidates: [] });
          for (const c of pendingAnswer) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(c));
          }
        }
        break;
      }

      case "ice-candidate": {
        // ICE candidates may arrive before SDP offer/answer via WS.
        // addIceCandidate throws InvalidStateError if remoteDescription is null — queue and flush later.
        if (!data.candidate) break;

        const candidateInit = data.candidate as RTCIceCandidateInit;

        if (!peerConnection || !peerConnection.remoteDescription) {
          set((state) => ({
            _pendingCandidates: [...state._pendingCandidates, candidateInit],
          }));
        } else {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit));
        }
        break;
      }
    }
  },
}));
