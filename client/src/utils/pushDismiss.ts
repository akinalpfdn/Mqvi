/**
 * Clears tray notifications for a conversation the user has now read.
 *
 * The OS keeps a delivered notification until it is tapped or swiped away, so reading the
 * conversation anywhere else — in the app, or on another device — leaves a stale one sitting
 * there. Capacitor only; a no-op on web and Electron.
 *
 * A DM notification is identified by its TAG, not by its data payload.
 *
 * While the app is backgrounded the notification is posted by the FCM SDK itself (the message
 * carries a `notification` payload), not by our code. Capacitor's getDeliveredNotifications()
 * builds its `data` field from the Android Notification's `extras` bundle — and the FCM SDK does
 * NOT put the data payload there; it puts it in the tap intent. So `data.dm_channel_id` is always
 * undefined for exactly the notifications we need to clear, and matching on it never removed a
 * single one. `tag` IS exposed, and the server sets it on every DM notification.
 */

import { PushNotifications } from "@capacitor/push-notifications";
import { isCapacitor } from "./constants";

/** Must match dmNotificationTag() on the server. */
const DM_TAG_PREFIX = "dm:";

function dmTagFor(dmChannelId: string): string {
  return DM_TAG_PREFIX + dmChannelId;
}

/** The conversation a DM notification belongs to, or null if the tag is not one of ours. */
function channelIdFromTag(tag: string | undefined): string | null {
  if (!tag || !tag.startsWith(DM_TAG_PREFIX)) return null;
  return tag.slice(DM_TAG_PREFIX.length) || null;
}

export async function dismissNotificationsFor(dmChannelId: string): Promise<void> {
  const wanted = dmTagFor(dmChannelId);
  await removeWhere((tag) => tag === wanted);
}

/**
 * Clears every DM notification except the conversations the server still counts as unread.
 * Run when the app reconnects: a device that was asleep or killed never saw the dm_read event or
 * its retraction push, so it comes back holding notifications for conversations read hours ago.
 */
export async function dismissReadNotifications(unreadChannelIds: Set<string>): Promise<void> {
  await removeWhere((tag) => {
    const channelId = channelIdFromTag(tag);
    return channelId !== null && !unreadChannelIds.has(channelId);
  });
}

/** One scan of the tray. Only ever touches DM notifications — never the call notification. */
async function removeWhere(matches: (tag: string) => boolean): Promise<void> {
  if (!isCapacitor()) return;

  try {
    const delivered = await PushNotifications.getDeliveredNotifications();
    const stale = delivered.notifications.filter((n) => {
      const tag = n.tag;
      return typeof tag === "string" && channelIdFromTag(tag) !== null && matches(tag);
    });
    if (stale.length === 0) return;

    await PushNotifications.removeDeliveredNotifications({ notifications: stale });
  } catch (err) {
    console.warn("[push] failed to clear delivered notifications:", err);
  }
}
