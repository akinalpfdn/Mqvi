/**
 * The notification we need to clear is the one the FCM SDK posted while the app was backgrounded.
 * Capacitor exposes its `tag` but NOT its FCM data payload — the SDK puts that in the tap intent,
 * not in the Notification's extras bundle, which is where Capacitor reads `data` from. Matching on
 * data.dm_channel_id therefore never removed a single one of them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Delivered = { id: number; tag?: string; data?: Record<string, unknown> };

let tray: Delivered[] = [];
const removed: Delivered[][] = [];

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    getDeliveredNotifications: async () => ({ notifications: tray }),
    removeDeliveredNotifications: async ({ notifications }: { notifications: Delivered[] }) => {
      removed.push(notifications);
      tray = tray.filter((n) => !notifications.includes(n));
    },
  },
}));
vi.mock("./constants", () => ({ isCapacitor: () => true }));

import { dismissNotificationsFor, dismissReadNotifications } from "./pushDismiss";

/** What the FCM SDK actually posts: our tag survives, our data payload does not. */
function fcmPosted(id: number, dmChannelId: string): Delivered {
  return { id, tag: `dm:${dmChannelId}`, data: { "android.title": "Alice", "android.text": "hi" } };
}

beforeEach(() => {
  tray = [];
  removed.length = 0;
});

describe("dismissNotificationsFor", () => {
  it("removes the notification the FCM SDK posted, which carries no dm_channel_id", async () => {
    tray = [fcmPosted(1, "c1")];

    await dismissNotificationsFor("c1");

    expect(removed.flat()).toHaveLength(1);
    expect(removed.flat()[0].tag).toBe("dm:c1");
  });

  it("leaves other conversations alone", async () => {
    tray = [fcmPosted(1, "c1"), fcmPosted(2, "c2")];

    await dismissNotificationsFor("c1");

    expect(removed.flat().map((n) => n.tag)).toEqual(["dm:c1"]);
  });

  // The incoming-call notification has no dm: tag and must never be swept away by a DM read.
  it("never touches the call notification", async () => {
    tray = [{ id: 42, tag: undefined, data: { type: "call" } }, fcmPosted(1, "c1")];

    await dismissNotificationsFor("c1");

    expect(removed.flat().map((n) => n.id)).toEqual([1]);
  });
});

describe("dismissReadNotifications", () => {
  it("sweeps the conversations the server no longer counts as unread", async () => {
    tray = [fcmPosted(1, "read-one"), fcmPosted(2, "still-unread")];

    await dismissReadNotifications(new Set(["still-unread"]));

    expect(removed.flat().map((n) => n.tag)).toEqual(["dm:read-one"]);
  });

  it("never touches the call notification", async () => {
    tray = [{ id: 42, data: { type: "call" } }, fcmPosted(1, "read-one")];

    await dismissReadNotifications(new Set());

    expect(removed.flat().map((n) => n.id)).toEqual([1]);
  });
});
