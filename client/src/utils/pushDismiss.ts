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
  await removeWhere((id) => id === dmChannelId);
}

/**
 * Clears every DM notification except the conversations the server still counts as unread.
 * Run when the app reconnects: a device that was asleep or killed never saw the dm_read
 * event or its retraction push, so it comes back holding notifications for conversations
 * that were read elsewhere hours ago.
 */
export async function dismissReadNotifications(unreadChannelIds: Set<string>): Promise<void> {
  await removeWhere((id) => !unreadChannelIds.has(id));
}

/** One scan of the tray; drops every DM notification whose conversation matches. */
async function removeWhere(matches: (dmChannelId: string) => boolean): Promise<void> {
  if (!isCapacitor()) return;

  try {
    const delivered = await PushNotifications.getDeliveredNotifications();
    const stale = delivered.notifications.filter((n) => {
      const id = (n.data as Record<string, unknown> | undefined)?.dm_channel_id;
      return typeof id === "string" && matches(id);
    });
    if (stale.length === 0) return;

    await PushNotifications.removeDeliveredNotifications({ notifications: stale });
  } catch (err) {
    console.warn("[push] failed to clear delivered notifications:", err);
  }
}
