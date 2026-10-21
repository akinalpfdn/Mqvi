/**
 * The one live cache session, and the wipe. Kept apart from the writer, which imports the stores:
 * authStore needs the wipe, and importing the writer would close an import cycle through them.
 */

import { isNativeApp, SERVER_URL } from "../utils/constants";
import { indexedDBBackend, type CacheBackend } from "./cacheBackend";

/**
 * Native apps only (Capacitor, Electron). A browser can be a shared or public computer, where
 * decrypted messages would stay behind whenever nobody signs out.
 */
export function cacheEnabled(): boolean {
  return isNativeApp();
}

/** Records of one backend + account. A connection switch or another account never reads them. */
export function partitionFor(userId: string): string {
  return `${SERVER_URL || window.location.origin}|${userId}`;
}

type Session = { partition: string; stop: () => void };

let current: Session | null = null;

export function beginCacheSession(partition: string, stop: () => void): void {
  current?.stop();
  current = { partition, stop };
}

export function endCacheSession(partition: string): void {
  if (current?.partition === partition) current = null;
}

/** Writes check this right before their transaction, so none outlives its session. */
export function isCurrentPartition(partition: string): boolean {
  return current?.partition === partition;
}

/** Set before a wipe and cleared once it succeeded, so a wipe that failed is redone on next launch. */
const WIPE_PENDING_KEY = "mqvi_cache_wipe_pending";

/**
 * For sign-out, forced sign-out and an abandoned session: stops writing at once, then drops every
 * partition — tokens are global, so no other partition belongs to a live session either.
 *
 * Never throws, so it cannot hold a sign-out up; a failed wipe is not forgotten either — the
 * pending mark survives it and retryPendingWipe finishes the job at the next launch.
 */
export async function wipeConversationCache(backend: CacheBackend = indexedDBBackend): Promise<void> {
  current?.stop();
  current = null;
  if (!cacheEnabled()) return;
  localStorage.setItem(WIPE_PENDING_KEY, "1");
  try {
    await backend.clear(null);
    localStorage.removeItem(WIPE_PENDING_KEY);
  } catch (err) {
    console.error("[cache] wipe failed, retrying at next launch:", err);
  }
}

/** At launch, before anything reads the cache: finishes a wipe an earlier sign-out could not. */
export async function retryPendingWipe(backend: CacheBackend = indexedDBBackend): Promise<void> {
  if (localStorage.getItem(WIPE_PENDING_KEY)) await wipeConversationCache(backend);
}
