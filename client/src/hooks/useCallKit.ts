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

import { getCapacitorPlatform } from "../utils/constants";
import { registerPushToken } from "../api/push";
import { cacheVoipToken } from "../utils/pushToken";
import { P2PCall } from "../native/p2pCall";
import { useP2PCallStore } from "../stores/p2pCallStore";

// Just past the server's 60s ring timeout.
const PENDING_ACCEPT_TTL = 65_000;

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

    function clearPending(): void {
      pendingAccept = null;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }

    function setPending(callId: string): void {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingAccept = callId;
      pendingTimer = setTimeout(() => {
        pendingAccept = null;
        pendingTimer = null;
      }, PENDING_ACCEPT_TTL);
    }

    function registerVoip(token: string): void {
      if (!token) return;
      cacheVoipToken(token);
      void registerPushToken({ token, platform: "ios", token_type: "apns_voip" }).then((res) => {
        if (!res.success) console.error("[callkit] voip token register failed:", res.error);
      });
    }

    async function setup(): Promise<void> {
      // Fetch the current token in case its event fired before this listener attached.
      const { token } = await P2PCall.getVoipToken();
      registerVoip(token);

      handles.push(
        await P2PCall.addListener("voipToken", ({ token: t }) => registerVoip(t)),
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
        await P2PCall.addListener("callEnded", ({ call_id }) => {
          // CallKit already ended it natively — nothing left to dismiss.
          callKitCalls.delete(call_id);
          reportedCalls.delete(call_id);
          if (pendingAccept === call_id) clearPending();
          const store = useP2PCallStore.getState();
          if (store.incomingCall?.id === call_id) store.declineCall(call_id);
          else if (store.activeCall?.id === call_id) store.endCall();
        }),
      );
    }

    void setup().catch((err) => console.error("[callkit] setup failed:", err));

    const unsubscribe = useP2PCallStore.subscribe((state) => {
      const incomingId = state.incomingCall?.id ?? null;
      const activeId = state.activeCall?.id ?? null;
      const currentId = activeId ?? incomingId;

      if (pendingAccept && state.incomingCall?.id === pendingAccept) {
        const id = pendingAccept;
        clearPending();
        state.acceptCall(id);
      }

      if (incomingId) reportedCalls.add(incomingId);

      // Answered inside the app: CallKit is still showing this call and nothing else will take
      // it down. A call answered from the CallKit screen is left alone — there it is genuinely
      // the system's active call until it ends.
      if (activeId && reportedCalls.has(activeId) && !callKitCalls.has(activeId)) {
        reportedCalls.delete(activeId);
        void P2PCall.endCall({ call_id: activeId });
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

    return () => {
      clearPending();
      handles.forEach((h) => void h.remove());
      unsubscribe();
    };
  }, []);
}
