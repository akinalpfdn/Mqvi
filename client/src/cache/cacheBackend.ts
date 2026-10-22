/**
 * Storage behind the on-device conversation cache. An interface so the cache's rules (eviction,
 * partitioning, wipe) are tested against the real code with an in-memory backend; the IndexedDB
 * implementation below only moves records.
 *
 * A database of its own, not a store in mqvi_e2ee: a schema change here must never put the
 * device's encryption keys through an upgrade.
 */

import { openDB, type IDBPDatabase } from "idb";
import type { LayoutNode, Panel } from "../stores/uiStore";
import type {
  CategoryWithChannels,
  MessageReference,
  DMChannelWithUser,
  DMMessage,
  Message,
  ServerListItem,
  User,
} from "../types";

/** Bumped when a record's shape changes; records of another version are ignored and dropped. */
export const CACHE_SCHEMA = 1;

type ConversationBase = {
  /** `${partition}|${kind}:${id}` */
  key: string;
  partition: string;
  id: string;
  hasMore: boolean;
  /** When the user last opened it — the recency order eviction follows. */
  openedAt: number;
  schema: number;
};

export type CachedConversation =
  | (ConversationBase & { kind: "channel"; serverId: string; messages: Message[] })
  | (ConversationBase & { kind: "dm"; messages: DMMessage[] });

export type CachedShell = {
  partition: string;
  schema: number;
  user: User;
  servers: ServerListItem[];
  categoriesByServer: Record<string, CategoryWithChannels[]>;
  dmChannels: DMChannelWithUser[];
  unreadCounts: Record<string, number>;
  /** channel → server, which the per-server unread totals are summed by. */
  channelServerMap: Record<string, string>;
  dmUnreadCounts: Record<string, number>;
  /** Open conversation tabs and the split layout; only channel and DM tabs are kept. */
  ui: CachedLayout;
};

export type CachedLayout = {
  panels: Record<string, Panel>;
  layout: LayoutNode;
  activePanelId: string;
};

/** An unsent message, kept so it survives a restart and goes out under the nonce it already has. */
export type CachedPending = {
  /** `${partition}|${nonce}` */
  key: string;
  partition: string;
  schema: number;
  nonce: string;
  kind: "channel" | "dm";
  conversationId: string;
  serverId?: string;
  content: string;
  replyToId: string | null;
  referencedMessage: MessageReference | null;
  createdAt: string;
  files: File[];
  /** The files could not be stored (quota): the text survives, the user has to attach them again. */
  filesLost: boolean;
};

/**
 * Every write takes `stillCurrent`, checked after the database is open and before the transaction
 * starts. A write queued before a sign-out would otherwise land after the wipe and put the
 * signed-out account's messages back.
 */
export type CacheBackend = {
  listConversations(partition: string): Promise<CachedConversation[]>;
  putConversation(conversation: CachedConversation, stillCurrent: () => boolean): Promise<void>;
  deleteConversations(keys: string[]): Promise<void>;
  getShell(partition: string): Promise<CachedShell | undefined>;
  putShell(shell: CachedShell, stillCurrent: () => boolean): Promise<void>;
  listPending(partition: string): Promise<CachedPending[]>;
  putPending(pending: CachedPending, stillCurrent: () => boolean): Promise<void>;
  deletePending(key: string): Promise<void>;
  /** Drops every record not in `keep`; null drops everything. */
  clear(keep: string | null): Promise<void>;
};

const DB_NAME = "mqvi_cache";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("conversations")) {
        const store = db.createObjectStore("conversations", { keyPath: "key" });
        store.createIndex("partition", "partition");
      }
      if (!db.objectStoreNames.contains("shell")) {
        db.createObjectStore("shell", { keyPath: "partition" });
      }
      if (!db.objectStoreNames.contains("outbox")) {
        const store = db.createObjectStore("outbox", { keyPath: "key" });
        store.createIndex("partition", "partition");
      }
    },
  });
  return dbPromise;
}

export const indexedDBBackend: CacheBackend = {
  async listConversations(partition) {
    const db = await getDB();
    return (await db.getAllFromIndex("conversations", "partition", partition)) as CachedConversation[];
  },

  async putConversation(conversation, stillCurrent) {
    const db = await getDB();
    if (!stillCurrent()) return;
    await db.put("conversations", conversation);
  },

  async deleteConversations(keys) {
    if (keys.length === 0) return;
    const db = await getDB();
    const tx = db.transaction("conversations", "readwrite");
    await Promise.all([...keys.map((key) => tx.store.delete(key)), tx.done]);
  },

  async getShell(partition) {
    const db = await getDB();
    return (await db.get("shell", partition)) as CachedShell | undefined;
  },

  async putShell(shell, stillCurrent) {
    const db = await getDB();
    if (!stillCurrent()) return;
    await db.put("shell", shell);
  },

  async listPending(partition) {
    const db = await getDB();
    return (await db.getAllFromIndex("outbox", "partition", partition)) as CachedPending[];
  },

  async putPending(pending, stillCurrent) {
    const db = await getDB();
    if (!stillCurrent()) return;
    await db.put("outbox", pending);
  },

  async deletePending(key) {
    const db = await getDB();
    await db.delete("outbox", key);
  },

  async clear(keep) {
    const db = await getDB();
    const names = ["conversations", "shell", "outbox"] as const;
    const tx = db.transaction([...names], "readwrite");
    if (keep === null) {
      await Promise.all([...names.map((name) => tx.objectStore(name).clear()), tx.done]);
      return;
    }
    for (const name of names) {
      const store = tx.objectStore(name);
      for (let cursor = await store.openCursor(); cursor; cursor = await cursor.continue()) {
        if ((cursor.value as { partition: string }).partition !== keep) await cursor.delete();
      }
    }
    await tx.done;
  },
};
