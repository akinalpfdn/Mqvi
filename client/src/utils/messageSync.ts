import { DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_PAGE } from "./constants";

/**
 * How many newest messages a resync asks for: the whole window held, so a delete or edit anywhere
 * in it is reconciled, within what the server serves. Never above MAX_MESSAGE_PAGE — the server
 * answers a larger limit with its default of 50, not with 100.
 */
export function resyncLimit(heldCount: number): number {
  return Math.min(Math.max(heldCount, DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_PAGE);
}

/** A per-conversation flag record with `id` set or cleared. Cleared keys are removed, not false. */
export function withFlag(flags: Record<string, true>, id: string, on: boolean): Record<string, true> {
  if (on) return flags[id] ? flags : { ...flags, [id]: true };
  if (!flags[id]) return flags;
  const next = { ...flags };
  delete next[id];
  return next;
}

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
 *
 * The page is the whole truth for the span it covers: a held message inside that span that the
 * page lacks was deleted while the socket was down (a delete leaves no trace on the server), so
 * it is dropped. Inside the span means between the first and last held messages the page also
 * has, or after them but strictly older than the page's newest message. A held message at or
 * after the page's newest second may have arrived over the socket after the page was read, so it
 * stays; so does anything older than the page, which the page says nothing about.
 */
export function mergeLatestPage<T extends { id: string; created_at: string }>(held: T[], page: T[]): MergedPage<T> {
  if (held.length === 0) return { messages: page, replaced: true };
  if (page.length === 0) return { messages: held, replaced: false };

  const pageIds = new Set(page.map((m) => m.id));
  let firstShared = -1;
  let lastShared = -1;
  held.forEach((m, i) => {
    if (!pageIds.has(m.id)) return;
    if (firstShared === -1) firstShared = i;
    lastShared = i;
  });
  if (firstShared === -1) return { messages: page, replaced: true };

  const pageNewest = Date.parse(page[page.length - 1].created_at);
  const deletedMeanwhile = (m: T, i: number) =>
    !pageIds.has(m.id) &&
    ((i > firstShared && i < lastShared) || (i > lastShared && Date.parse(m.created_at) < pageNewest));

  // Map keeps insertion order and updates in place; the stable sort then puts a page message
  // missed by the socket before a newer one the socket did deliver, and leaves same-second
  // messages in the order they were already shown.
  const byId = new Map(held.filter((m, i) => !deletedMeanwhile(m, i)).map((m) => [m.id, m]));
  for (const m of page) byId.set(m.id, m);
  const messages = [...byId.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return { messages, replaced: false };
}
