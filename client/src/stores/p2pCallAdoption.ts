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
  let abandoning = false;
  let release: Promise<boolean> | null = null;
  return {
    _adoptCandidate: null,
    _adoptTimer: null,
    _adopted: null,

    holdAdoptableCall: (call) => {
      abandoning = false;
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
      if (abandoning || !candidate || candidate.callId !== data.id) return;
      if (_adoptTimer) clearTimeout(_adoptTimer);
      const acceptedAt = data.accepted_at ? Date.parse(data.accepted_at) : NaN;
      set({
        _adoptCandidate: null,
        _adoptTimer: null,
        _adopted: { callId: data.id, inCallKit: candidate.inCallKit },
        activeCall: { ...data, status: "active" },
        incomingCall: null,
        isMuted: !candidate.micEnabled,
        isDeafened: candidate.deafened,
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
      if (release) return release;
      const { _adoptCandidate: candidate, _adoptTimer } = get();
      if (_adoptTimer) clearTimeout(_adoptTimer);
      set({ _adoptTimer: null });
      if (!candidate) return Promise.resolve(true);
      // Keep the candidate as an audio owner until native confirms release. Ignore late
      // adoption replies immediately; a failed bridge call must block channel voice and be retryable.
      abandoning = true;
      get().endOrphanedCall(candidate.callId, candidate.instanceId);
      release = NativeP2PCall.discardOrphanedCall()
        .then(() => {
          if (get()._adoptCandidate === candidate) set({ _adoptCandidate: null });
          return true;
        })
        .catch((err: unknown) => {
          console.error("[p2p] abandoning native adoption failed:", err);
          return false;
        })
        .finally(() => { release = null; });
      return release;
    },
  };
}
