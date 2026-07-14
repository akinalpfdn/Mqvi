/**
 * Mark-read bookkeeping that has to outlive a store instance: which watermark we have already
 * asked the server for, which one it has confirmed, and the coalescing timer.
 *
 * It lives here, with no imports, so authStore can clear it on logout without an import cycle —
 * and it MUST be cleared. The SPA does not reload between logout and login, so without this a
 * second user on the same desktop inherits the first user's dedupe state: they open a shared
 * conversation whose newest message is the one the first user already marked read, the guard
 * returns early, and their badge never clears while their phone keeps buzzing for the chat on
 * their screen.
 */

export type MarkReadTracker = {
  timers: Record<string, ReturnType<typeof setTimeout>>;
  /** The newest watermark we have asked the server for — in flight or confirmed. */
  asked: Record<string, string>;
  /** The newest watermark the server has confirmed. */
  sent: Record<string, string>;
};

function newTracker(): MarkReadTracker {
  return { timers: {}, asked: {}, sent: {} };
}

export const dmMarkRead = newTracker();
export const channelMarkRead = newTracker();

function clear(t: MarkReadTracker): void {
  for (const k of Object.keys(t.timers)) {
    clearTimeout(t.timers[k]);
    delete t.timers[k];
  }
  for (const k of Object.keys(t.asked)) delete t.asked[k];
  for (const k of Object.keys(t.sent)) delete t.sent[k];
}

/** Called on logout, and by tests. */
export function resetMarkReadTracking(): void {
  clear(dmMarkRead);
  clear(channelMarkRead);
}
