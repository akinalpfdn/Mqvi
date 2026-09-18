/**
 * useCallKit — wires the native iOS PushKit/CallKit bridge (P2PCall plugin) to the app:
 * registers the VoIP token, accepts/declines calls from the CallKit UI, and dismisses
 * CallKit when a CallKit-originated call ends in-app. iOS (Capacitor) only; a no-op
 * everywhere else.
 *
 * Cold-launch flow: a VoIP push reports the call to CallKit before the WebView loads.
 * When the user answers in CallKit, "callAnswered" may arrive before the call exists in
 * the store (the WS connect-replay delivers it shortly after) — we stash the id and
 * accept once it appears, with a TTL so a never-arriving call doesn't leave it stuck.
 */

import { useEffect } from "react";
import type { PluginListenerHandle } from "@capacitor/core";

import { App } from "@capacitor/app";

import { getCapacitorPlatform } from "../utils/constants";
import { syncVoipToken } from "../utils/pushToken";
import { P2PCall } from "../native/p2pCall";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useAuthStore } from "../stores/authStore";

// Just past the ring budget — after that the call is gone and a late answer means nothing.
const PENDING_ACCEPT_TTL = 35_000;

export function useCallKit(): void {
  useEffect(() => {
    if (getCapacitorPlatform() !== "ios") return;

    const handles: PluginListenerHandle[] = [];
    // call_ids answered from the CallKit screen. These stay live in CallKit for the whole
    // call and are only dismissed once they clear in-app.
    const callKitCalls = new Set<string>();
    // Every incoming call id seen on this device. The VoIP push reports the call to CallKit
    // even while the app is foreground, so answering or declining inside the app leaves that
    // screen up unless we take it down: the server excludes the device that acted from the
    // cancel push. Outgoing calls never enter this set, and must never be dismissed.
    const reportedCalls = new Set<string>();
    let pendingAccept: string | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCallId: string | null = null;
    // Declined on the CallKit screen before the call reached the store (app launched by the push).
    const pendingDeclines = new Map<string, ReturnType<typeof setTimeout>>();
    // The CallKit-rung call once it has shown up as incoming; its flag clears when it leaves.
    let systemRingSeen: string | null = null;

    function clearPending(): void {
      pendingAccept = null;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }

    // Sent now (queued if the socket is down) so the caller stops ringing; a re-delivery of the
    // call is declined again when it arrives.
    function declineUnseen(callId: string): void {
      useP2PCallStore.getState()._sendWS?.("p2p_call_decline", { call_id: callId });
      const existing = pendingDeclines.get(callId);
      if (existing) clearTimeout(existing);
      pendingDeclines.set(callId, setTimeout(() => pendingDeclines.delete(callId), PENDING_ACCEPT_TTL));
    }

    function setPending(callId: string): void {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingAccept = callId;
      pendingTimer = setTimeout(() => {
        pendingAccept = null;
        pendingTimer = null;
      }, PENDING_ACCEPT_TTL);
    }

    async function setup(): Promise<void> {
      // Fetch the current token in case its event fired before this listener attached.
      const { token } = await P2PCall.getVoipToken();
      void syncVoipToken(token);

      handles.push(
        await P2PCall.addListener("voipToken", ({ token: t }) => void syncVoipToken(t)),
      );
      // Foregrounding repairs a registration that failed while away; a recent one is skipped.
      handles.push(
        await App.addListener("appStateChange", ({ isActive }) => {
          if (!isActive) return;
          void P2PCall.getVoipToken().then(({ token: t }) => void syncVoipToken(t));
        }),
      );
      handles.push(
        await P2PCall.addListener("callAnswered", ({ call_id }) => {
          callKitCalls.add(call_id);
          const store = useP2PCallStore.getState();
          if (store.incomingCall?.id === call_id) {
            store.acceptCall(call_id);
          } else {
            setPending(call_id); // call not in state yet — accept on arrival
          }
        }),
      );
      handles.push(
        await P2PCall.addListener("callReported", ({ call_id }) => {
          // CallKit is ringing this one; the in-app overlay must not ring on top of it.
          reportedCalls.add(call_id);
          useP2PCallStore.setState({ systemRingingCallId: call_id });
        }),
      );
      handles.push(
        await P2PCall.addListener("callMuted", ({ call_id, muted }) => {
          const store = useP2PCallStore.getState();
          if (store.activeCall?.id !== call_id) return;
          if (store.isMuted !== muted) store.toggleMute();
        }),
      );
      handles.push(
        await P2PCall.addListener("callEnded", ({ call_id }) => {
          // CallKit already ended it natively — nothing left to dismiss.
          callKitCalls.delete(call_id);
          reportedCalls.delete(call_id);
          if (pendingAccept === call_id) clearPending();
          const store = useP2PCallStore.getState();
          if (store.systemRingingCallId === call_id) {
            useP2PCallStore.setState({ systemRingingCallId: null });
          }
          if (store.incomingCall?.id === call_id) store.declineCall(call_id);
          else if (store.activeCall?.id === call_id) store.endCall();
          else declineUnseen(call_id);
        }),
      );
    }

    void setup().catch((err) => console.error("[callkit] setup failed:", err));

    const unsubscribe = useP2PCallStore.subscribe((state) => {
      const incomingId = state.incomingCall?.id ?? null;
      const active = state.activeCall;
      const currentId = active?.id ?? incomingId;

      if (pendingAccept && state.incomingCall?.id === pendingAccept) {
        const id = pendingAccept;
        clearPending();
        state.acceptCall(id);
      }

      if (incomingId && pendingDeclines.has(incomingId)) {
        clearTimeout(pendingDeclines.get(incomingId));
        pendingDeclines.delete(incomingId);
        state.declineCall(incomingId);
        return;
      }

      // Only a call we are RECEIVING was reported to CallKit. handleCallInitiate mirrors the
      // event into incomingCall for the caller too, so the field alone does not say which side
      // this device is on — dismissing an outgoing call's screen would take down a call the
      // system never showed.
      const myId = useAuthStore.getState().user?.id;
      if (incomingId && state.incomingCall?.receiver_id === myId) {
        reportedCalls.add(incomingId);
      }

      // Cleared once the rung call has come and gone. The push can arrive before the WS event,
      // so an incoming call not there yet must not clear it, or the in-app ring plays over CallKit.
      const ringing = state.systemRingingCallId;
      if (ringing && incomingId === ringing) systemRingSeen = ringing;
      else if (ringing && systemRingSeen === ringing) {
        systemRingSeen = null;
        useP2PCallStore.setState({ systemRingingCallId: null });
      }

      // Answered inside the app: CallKit is still showing this call and nothing else will take
      // it down. The status is what says "answered" — handleCallInitiate puts a RINGING call in
      // activeCall as well as incomingCall, so the presence of an active call means nothing.
      // A call answered from the CallKit screen is left alone: there it is genuinely the
      // system's active call until it ends.
      if (active && active.status === "active" && reportedCalls.has(active.id) && !callKitCalls.has(active.id)) {
        reportedCalls.delete(active.id);
        void P2PCall.endCall({ call_id: active.id });
      }

      // Cleared in-app (declined, ended, timed out): take down whatever CallKit still holds.
      if (lastCallId && currentId === null && (callKitCalls.has(lastCallId) || reportedCalls.has(lastCallId))) {
        const id = lastCallId;
        callKitCalls.delete(id);
        reportedCalls.delete(id);
        void P2PCall.endCall({ call_id: id });
      }
      lastCallId = currentId;
    });

    // Mirror in-app mutes to the CallKit screen; native skips a call it is not showing and repeats.
    const unsubscribeMute = useP2PCallStore.subscribe((state, prev) => {
      if (state.isMuted === prev.isMuted || !state.activeCall) return;
      void P2PCall.setMuted({ call_id: state.activeCall.id, muted: state.isMuted }).catch((err) =>
        console.error("[callkit] setMuted failed:", err),
      );
    });

    return () => {
      clearPending();
      pendingDeclines.forEach((timer) => clearTimeout(timer));
      pendingDeclines.clear();
      handles.forEach((h) => void h.remove());
      unsubscribe();
      unsubscribeMute();
    };
  }, []);
}
