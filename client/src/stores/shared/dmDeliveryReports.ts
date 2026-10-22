/**
 * The recipient side of the double tick: telling the server how far this app has received each
 * DM conversation. Bunched per conversation — a burst of messages is one report of the newest —
 * and never repeated for a message already reported.
 */

import { markDMDelivered, markDMsDeliveredLatest } from "../../api/dm";

/** Mark-read's pace: a busy conversation sends one report a second, not one per message. */
export const REPORT_DELAY_MS = 1_000;

const reported = new Map<string, string>();
/** conversation → the last_message_at its latest message was reported for, by the batch. */
const latestReported = new Map<string, string>();
const queued = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush(): Promise<void> {
  timer = undefined;
  const batch = [...queued];
  queued.clear();
  await Promise.all(
    batch.map(async ([channelId, messageId]) => {
      const res = await markDMDelivered(channelId, messageId);
      // Forgotten on failure so the next message, page or connect reports it again.
      if (res.success) reported.set(channelId, messageId);
    })
  );
}

/** This app now holds the conversation up to messageId (a socket message, a fetched page). */
export function reportDMDelivered(channelId: string, messageId: string): void {
  if (reported.get(channelId) === messageId) return;
  queued.set(channelId, messageId);
  timer ??= setTimeout(() => void flush(), REPORT_DELAY_MS);
}

/**
 * Just connected: these conversations have news the app knows of but has not downloaded. Only the
 * ones whose newest message changed since the last report: an old unread conversation would
 * otherwise go out again on every reconnect, each one a write attempt on the server.
 */
export async function reportDMsDeliveredLatest(conversations: { id: string; lastMessageAt: string }[]): Promise<void> {
  const changed = conversations.filter((c) => latestReported.get(c.id) !== c.lastMessageAt);
  if (changed.length === 0) return;
  const res = await markDMsDeliveredLatest(changed.map((c) => c.id));
  // Forgotten on failure, so the next connect reports them again.
  if (res.success) for (const c of changed) latestReported.set(c.id, c.lastMessageAt);
}

/** Sign-out: the next account starts with nothing reported. */
export function resetDMDeliveryReports(): void {
  clearTimeout(timer);
  timer = undefined;
  reported.clear();
  latestReported.clear();
  queued.clear();
}
