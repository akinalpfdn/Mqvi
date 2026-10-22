/** In-memory stand-in for the cache's IndexedDB backend, with the same contract (stillCurrent included). */
import type { CacheBackend, CachedConversation, CachedPending, CachedShell } from "../cache/cacheBackend";

export function memoryBackend() {
  const conversations = new Map<string, CachedConversation>();
  const shells = new Map<string, CachedShell>();
  const outbox = new Map<string, CachedPending>();
  const backend: CacheBackend & { failClear: boolean; failFiles: boolean; putDelay: number } = {
    failClear: false,
    failFiles: false,
    putDelay: 0,
    async listPending(partition) {
      return [...outbox.values()].filter((p) => p.partition === partition);
    },
    async putPending(p, stillCurrent) {
      await new Promise((r) => setTimeout(r, backend.putDelay));
      if (backend.failFiles && p.files.length > 0) throw new DOMException("full", "QuotaExceededError");
      if (stillCurrent()) outbox.set(p.key, p);
    },
    async deletePending(key) { outbox.delete(key); },
    async listConversations(partition) {
      return [...conversations.values()].filter((c) => c.partition === partition);
    },
    async putConversation(c, stillCurrent) {
      await Promise.resolve();
      if (stillCurrent()) conversations.set(c.key, structuredClone(c));
    },
    async deleteConversations(keys) { keys.forEach((k) => conversations.delete(k)); },
    async getShell(partition) { return shells.get(partition); },
    async putShell(s, stillCurrent) {
      await Promise.resolve();
      if (stillCurrent()) shells.set(s.partition, structuredClone(s));
    },
    async clear(keep) {
      if (backend.failClear) throw new Error("disk");
      for (const [k, c] of conversations) if (c.partition !== keep) conversations.delete(k);
      for (const [k, s] of shells) if (s.partition !== keep) shells.delete(k);
      for (const [k, p] of outbox) if (p.partition !== keep) outbox.delete(k);
    },
  };
  return { backend, conversations, shells, outbox };
}

