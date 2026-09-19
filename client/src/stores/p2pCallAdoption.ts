/**
 * Taking over a call the previous page ran. iOS can kill the page (WKWebView's process) in the
 * background while the call's native media runs on; the reloaded page is a new app instance that
 * asks the server to hand it the call, instead of hanging up a healthy call.
 */

import type { StoreApi } from "zustand";

import { NativeP2PCall } from "../native/nativeP2PCall";
import { remoteVideo } from "./shared/p2pRemoteVideo";
import type { P2PCallStore } from "./p2pCallStore";

/** How long a reloaded page waits for the server to hand it the call its predecessor ran. */
const ADOPT_WAIT_MS = 30_000;

type AdoptionSlice = Pick<
  P2PCallStore,
  "_adoptCandidate" | "_adoptTimer" | "_adopted" | "holdAdoptableCall" | "handleCallAdopted" | "abandonAdoption"
>;

export function createAdoptionSlice(
  set: StoreApi<P2PCallStore>["setState"],
  get: StoreApi<P2PCallStore>["getState"],
): AdoptionSlice {
  return {
    _adoptCandidate: null,
    _adoptTimer: null,
    _adopted: null,

    holdAdoptableCall: (call) => {
      // Without the old page's instance the server cannot hand the call over; and once this page
      // has connected without claiming it, the server has already released it.
      if (!call.instanceId || get()._sessionId) {
        void NativeP2PCall.discardOrphanedCall().catch(() => {});
        get().endOrphanedCall(call.callId, call.instanceId);
        return;
      }
      // Counted from now, not from the connection: with no connection at all the call would run on
      // with no screen to end it from.
      set({ _adoptCandidate: call, _adoptTimer: setTimeout(() => get().abandonAdoption(), ADOPT_WAIT_MS) });
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
      void engine?.takeOver(candidate).then((running) => {
        if (running) engine.resync();
        else if (get().activeCall?.id === data.id) get().endCall("failed");
      });
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
  };
}
