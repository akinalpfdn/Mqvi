export type MergedPage<T> = {
  messages: T[];
  /** The page replaced the held window, so has_more has to be taken from the server. */
  replaced: boolean;
};

/**
 * Folds a freshly fetched newest page into the messages already in the store.
 *
 * Messages are ordered oldest-first and paginate backwards with a `before` cursor, so the
 * newest page is the only one we can refetch. When it overlaps what we hold, the two are
 * unioned and scrollback survives. When it does not, more than a page arrived while the
 * socket was down and everything we hold now sits across an invisible gap — the page
 * replaces it, and the caller re-paginates upwards from there.
 */
export function mergeLatestPage<T extends { id: string }>(held: T[], page: T[]): MergedPage<T> {
  if (held.length === 0) return { messages: page, replaced: true };
  if (page.length === 0) return { messages: held, replaced: false };

  const heldIds = new Set(held.map((m) => m.id));
  if (!page.some((m) => heldIds.has(m.id))) return { messages: page, replaced: true };

  // Map keeps insertion order and updates in place, so held order survives and the genuinely
  // new messages — all newer than anything held — land at the end.
  const byId = new Map(held.map((m) => [m.id, m]));
  for (const m of page) byId.set(m.id, m);
  return { messages: [...byId.values()], replaced: false };
}
