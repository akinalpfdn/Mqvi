/**
 * Cold start from the device cache: the shell, the cached conversations, unsent messages and the
 * open tabs go into the stores before any network response, so the app opens on what the user
 * last saw. GET /users/me and the socket then catch up; a rejected session still signs out.
 */

import { useAuthStore } from "../stores/authStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useDMStore } from "../stores/dmStore";
import { useReadStateStore } from "../stores/readStateStore";
import { useMessageStore } from "../stores/messageStore";
import { useUIStore, type Tab } from "../stores/uiStore";
import { useOutboxStore, previewAttachments } from "../stores/outboxStore";
import { CACHE_SCHEMA, indexedDBBackend, type CacheBackend, type CachedPending, type CachedShell } from "./cacheBackend";
import { cacheEnabled, cachedUserId, partitionFor, retryPendingWipe } from "./cacheSession";

/** A tab comes back only if what it shows is still in the shell the user can see. */
function canReopen(shell: CachedShell): (tab: Tab) => boolean {
  const dmIds = new Set(shell.dmChannels.map((ch) => ch.id));
  return (tab) => {
    if (tab.type === "dm") return dmIds.has(tab.channelId);
    const serverId = tab.serverInfo?.serverId;
    const categories = serverId ? shell.categoriesByServer[serverId] : undefined;
    return !!categories?.some((cg) => cg.channels.some((ch) => ch.id === tab.channelId));
  };
}

function restorePending(records: CachedPending[]): void {
  const outbox = useOutboxStore.getState();
  const ordered = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of ordered) {
    if (r.schema !== CACHE_SCHEMA || outbox.find(r.nonce)) continue;
    outbox.add({
      nonce: r.nonce,
      kind: r.kind,
      conversationId: r.conversationId,
      serverId: r.serverId,
      content: r.content,
      files: r.files,
      attachments: previewAttachments(r.files),
      replyToId: r.replyToId,
      referencedMessage: r.referencedMessage,
      createdAt: r.createdAt,
      // Failed until it is tried again: text goes out by itself on the next connect, under the
      // nonce it had. One that lost its files waits for the user, who has to attach them again.
      status: "failed",
      failure: r.filesLost ? "rejected" : "transient",
      filesLost: r.filesLost,
    });
  }
}

function hydrateShell(shell: CachedShell): void {
  useServerStore.setState({ servers: shell.servers });
  const activeServerId = useServerStore.getState().activeServerId;
  useChannelStore.setState({
    categoriesByServer: shell.categoriesByServer,
    categories: (activeServerId && shell.categoriesByServer[activeServerId]) || [],
  });
  useDMStore.setState({ channels: shell.dmChannels, dmUnreadCounts: shell.dmUnreadCounts });
  useReadStateStore.setState({ unreadCounts: shell.unreadCounts, channelServerMap: shell.channelServerMap });
}

/**
 * True when the app was opened from the cache — the caller then lets GET /users/me run in the
 * background instead of in front. False (nothing changed) in a browser, with no stored session,
 * or when nothing is cached for it.
 */
export async function restoreFromCache(backend: CacheBackend = indexedDBBackend): Promise<boolean> {
  if (!cacheEnabled() || !localStorage.getItem("access_token")) return false;
  try {
    // A sign-out whose wipe failed must not be undone by reading what it left.
    await retryPendingWipe(backend);
    const userId = cachedUserId();
    if (!userId) return false;

    const partition = partitionFor(userId);
    const shell = await backend.getShell(partition);
    if (!shell || shell.schema !== CACHE_SCHEMA || shell.user.id !== userId) return false;
    const [conversations, pending] = await Promise.all([
      backend.listConversations(partition),
      backend.listPending(partition),
    ]);

    hydrateShell(shell);
    for (const c of conversations) {
      if (c.schema !== CACHE_SCHEMA) continue;
      if (c.kind === "channel") useMessageStore.getState().hydrateConversation(c.id, c.messages, c.hasMore);
      else useDMStore.getState().hydrateConversation(c.id, c.messages, c.hasMore);
    }
    restorePending(pending);
    useUIStore.getState().restoreLayout(shell.ui, canReopen(shell));

    useAuthStore.getState().openFromCache(shell.user);
    return true;
  } catch (err) {
    // Starting the normal way is always possible; a cache that cannot be read is not a reason to fail.
    console.error("[cache] could not start from the cache:", err);
    return false;
  }
}
