/**
 * Per-key serialization for the ratchet's read-modify-write state.
 *
 * Signal sessions and sender keys live in IndexedDB and are used as load → mutate → save. A read
 * hands back an independent structured clone, so two operations that overlap both start from the
 * same state and whichever saves last silently discards the other's advance — a chain key step, a
 * skipped-key entry, or a message counter simply disappears. The socket makes that easy to hit:
 * inbound events are routed without awaiting, so two messages on one conversation decrypt at once.
 *
 * Keyed, never global. Decrypting a channel's backlog touches many distinct sessions and has to
 * keep running them in parallel.
 *
 * This is not a nonce-reuse guard — both AES-GCM paths draw a fresh random IV per call. It exists
 * to keep persisted ratchet state consistent.
 *
 * Locks are leaf-level: every holder must be a function that does not itself call another locked
 * function on the same key. Nesting would deadlock, since this lock is not reentrant.
 */

/** Tail of the queue per key. Always settles fulfilled, so a failure never poisons the chain. */
const tails = new Map<string, Promise<void>>();

/** Signal session, identified by the peer device the ratchet is with. */
export function signalSessionKey(userId: string, deviceId: string): string {
  return `sig:${userId}:${deviceId}`;
}

/** Sender key, identified by the channel and the device whose chain it is. */
export function senderKeyLockKey(channelId: string, userId: string, deviceId: string): string {
  return `skey:${channelId}:${userId}:${deviceId}`;
}

/**
 * Runs `critical` once every earlier call for the same key has finished. Returns what `critical`
 * returns, and propagates its rejection to this caller only.
 */
export function withSessionLock<T>(key: string, critical: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();

  // Same callback on both settle paths: a critical section that threw still has to let its
  // successor run, which is what "release in finally" means for a promise chain.
  const result = previous.then(critical, critical);

  // The queue itself must never reject, or every later caller would inherit an unrelated failure
  // and the rejection would surface as unhandled.
  const tail = result.then(
    () => {},
    () => {}
  );
  tails.set(key, tail);

  void tail.then(() => {
    // Last one out drops the entry. Without this the map keeps a promise per session for the
    // lifetime of the tab. A caller that queued behind us has already replaced the tail, so the
    // identity check is what makes this safe.
    if (tails.get(key) === tail) tails.delete(key);
  });

  return result;
}

/** Number of keys with work queued or awaiting cleanup. Diagnostics and tests only. */
export function pendingSessionLocks(): number {
  return tails.size;
}
