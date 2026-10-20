/**
 * When to ask for a store review: on the 10th open of an app version, at most once per version.
 * An open is a launch, or coming back after at least 30 minutes away — a quick app switch is not one.
 */

export const REVIEW_AFTER_OPENS = 10;
export const NEW_OPEN_AFTER_MS = 30 * 60 * 1000;

export type ReviewRecord = {
  version: string;
  opens: number;
  asked: boolean;
  /** When the app was last seen in the foreground, ms. */
  lastSeenAt: number;
};

/** Counts this foreground arrival if it is an open; a new app version starts the count over. */
export function recordForeground(record: ReviewRecord | null, version: string, now: number): ReviewRecord {
  if (!record || record.version !== version) {
    return { version, opens: 1, asked: false, lastSeenAt: now };
  }
  const isOpen = now - record.lastSeenAt >= NEW_OPEN_AFTER_MS;
  return { ...record, opens: isOpen ? record.opens + 1 : record.opens, lastSeenAt: now };
}

/** The app went to the background now; the time away starts here. */
export function recordBackground(record: ReviewRecord, now: number): ReviewRecord {
  return { ...record, lastSeenAt: now };
}

/** Busy means in a call or a voice channel: never interrupt those. */
export function shouldAskForReview(record: ReviewRecord, busy: boolean): boolean {
  return !record.asked && record.opens >= REVIEW_AFTER_OPENS && !busy;
}
