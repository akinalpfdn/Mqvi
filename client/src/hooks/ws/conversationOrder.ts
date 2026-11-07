/**
 * Per-conversation ordering for inbound WS events.
 *
 * Encrypted message events wait on decryption (IndexedDB, sometimes a sender-key fetch) while the
 * events that follow them about the same message do not. Routed without ordering, a delete or edit
 * landed first — on a message not stored yet — and the create then stored the stale message for
 * good. Events of one conversation therefore run one after another, in arrival order.
 *
 * Keyed, never global: heartbeat acks, presence, voice and call signaling must never wait behind a
 * slow decryption, and neither must other conversations.
 */
import type { WSMessage } from "../../types";

/**
 * How long a conversation waits for an event that does not finish. Decryption can hang on a request
 * with no timeout of its own; past this the conversation moves on, and the late event still lands
 * when it finally completes.
 */
const STALL_LIMIT_MS = 10_000;

const CHANNEL_OPS = new Set([
  "message_create",
  "message_update",
  "message_delete",
  "reaction_update",
  "message_pin",
  "message_unpin",
]);

const DM_OPS = new Set([
  "dm_message_create",
  "dm_message_update",
  "dm_message_delete",
  "dm_reaction_update",
  "dm_message_pin",
  "dm_message_unpin",
  "dm_delivered",
  "dm_read",
]);

/** Tail of each conversation's queue. Always settles fulfilled, so one failure never stalls the rest. */
const tails = new Map<string, Promise<void>>();

function conversationKey(msg: WSMessage): string | null {
  const d = msg.d as { channel_id?: unknown; dm_channel_id?: unknown } | null | undefined;
  if (CHANNEL_OPS.has(msg.op) && typeof d?.channel_id === "string") return `ch:${d.channel_id}`;
  if (DM_OPS.has(msg.op) && typeof d?.dm_channel_id === "string") return `dm:${d.dm_channel_id}`;
  return null;
}

function settleWithin(task: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    task.catch(() => {}).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Routes msg after every earlier event of its conversation; events outside a conversation run at once. */
export function dispatchInConversationOrder(msg: WSMessage, route: (msg: WSMessage) => Promise<void>): Promise<void> {
  const key = conversationKey(msg);
  if (!key) return route(msg);

  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.then(() => settleWithin(route(msg), STALL_LIMIT_MS));
  tails.set(key, current);
  void current.then(() => {
    if (tails.get(key) === current) tails.delete(key);
  });
  return current;
}
