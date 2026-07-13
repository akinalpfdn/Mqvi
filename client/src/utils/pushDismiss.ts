/**
 * Clears tray notifications for a conversation the user has now read.
 *
 * The OS keeps a delivered notification until it is tapped or swiped away, so reading the
 * conversation anywhere else — in the app, or on another device — leaves a stale badge
 * sitting there. Capacitor only; a no-op on web and Electron.
 */

import { PushNotifications } from "@capacitor/push-notifications";
import { isCapacitor } from "./constants";

export async function dismissNotificationsFor(dmChannelId: string): Promise<void> {
  if (!isCapacitor()) return;

  try {
    const delivered = await PushNotifications.getDeliveredNotifications();
    const stale = delivered.notifications.filter(
      (n) => (n.data as Record<string, unknown> | undefined)?.dm_channel_id === dmChannelId
    );
    if (stale.length === 0) return;

    await PushNotifications.removeDeliveredNotifications({ notifications: stale });
  } catch (err) {
    console.warn("[push] failed to clear delivered notifications:", err);
  }
}
