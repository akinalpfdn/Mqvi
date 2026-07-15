/**
 * usePushNotifications — registers the device for FCM push notifications and wires
 * up notification channels, tap-to-navigate, and foreground handling.
 *
 * Capacitor (mobile) only; a no-op on web and Electron. Called once from AppLayout
 * while authenticated.
 */

import { useEffect } from "react";
import { PushNotifications } from "@capacitor/push-notifications";
import type { PluginListenerHandle } from "@capacitor/core";

import { isCapacitor, getCapacitorPlatform } from "../utils/constants";
import { syncPushToken } from "../utils/pushToken";
import { useDMStore } from "../stores/dmStore";
import { useUIStore } from "../stores/uiStore";
import i18n from "../i18n";

// Android notification channel for DM/message pushes (id matches pkg/push androidConfig).
// The incoming-call channel ("incoming_call") is created natively by IncomingCallService,
// which owns its own looping ringtone + vibration — see android/.../IncomingCallService.kt.
async function ensureChannels(): Promise<void> {
  if (getCapacitorPlatform() !== "android") return;
  await PushNotifications.createChannel({
    id: "messages",
    name: i18n.t("notifChannels.messages"),
    description: i18n.t("notifChannels.messagesDesc"),
    importance: 4, // HIGH — heads-up banner
    visibility: 1, // PUBLIC
  });
}

// Tapping a notification opens the relevant conversation.
function handleNotificationTap(data: Record<string, unknown>, title?: string): void {
  if (data.type === "dm" && typeof data.dm_channel_id === "string") {
    useDMStore.getState().selectDM(data.dm_channel_id);
    useUIStore.getState().openTab(data.dm_channel_id, "dm", title ?? "");
  }
  // type === "call": the tap foregrounds the app; the connect-time call replay
  // re-delivers the ringing call, which raises the incoming-call overlay.
}

export function usePushNotifications(): void {
  useEffect(() => {
    if (!isCapacitor()) return;

    const handles: PluginListenerHandle[] = [];
    let cancelled = false;

    async function setup(): Promise<void> {
      // Attach listeners FIRST — before the permission round-trip — so the tap action
      // of a notification that cold-launched the app isn't missed.
      handles.push(
        await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
          handleNotificationTap(action.notification?.data ?? {}, action.notification?.title);
        }),
      );
      // Foreground receipt: the live WS connection already delivers the message/call
      // in-app, so we intentionally don't raise a duplicate OS notification.
      // dm_read retractions never land here either — both platforms handle them natively
      // (Android: MqviMessagingService, iOS: AppDelegate.didReceiveRemoteNotification),
      // because a background push must work while the WebView is suspended.
      handles.push(
        await PushNotifications.addListener("pushNotificationReceived", () => {}),
      );
      handles.push(
        await PushNotifications.addListener("registration", (token) => {
          void syncPushToken(token.value);
        }),
      );
      handles.push(
        await PushNotifications.addListener("registrationError", (err) => {
          console.error("[push] registration error:", err.error);
        }),
      );
      if (cancelled) return;

      const perm = await PushNotifications.requestPermissions();
      if (perm.receive !== "granted") {
        console.warn("[push] permission not granted:", perm.receive);
        return;
      }

      await ensureChannels();
      await PushNotifications.register();
    }

    void setup().catch((err) => console.error("[push] setup failed:", err));

    return () => {
      cancelled = true;
      handles.forEach((h) => void h.remove());
    };
  }, []);
}
