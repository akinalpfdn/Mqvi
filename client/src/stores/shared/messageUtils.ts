/**
 * Shared Message Utilities — extracted from messageStore and dmStore
 * to eliminate duplication in message CRUD, typing, and WS handlers.
 */

import i18n from "../../i18n";
import { encryptFile } from "../../crypto/fileEncryption";
import { useToastStore } from "../toastStore";
import type { EncryptedFileMeta } from "../../crypto/fileEncryption";
import type { ReactionGroup } from "../../types";

// ─── File Encryption ───

export type EncryptedFileResult = {
  files: File[];
  metas: EncryptedFileMeta[];
};

/**
 * Encrypts files with AES-256-GCM for E2EE messages.
 * Shared between channel and DM sendMessage flows.
 */
export async function encryptFilesForE2EE(
  files: File[]
): Promise<EncryptedFileResult> {
  const encrypted: File[] = [];
  const metas: EncryptedFileMeta[] = [];

  for (let i = 0; i < files.length; i++) {
    const result = await encryptFile(files[i]);
    encrypted.push(
      new File([result.encryptedBlob], `encrypted_${i}.bin`, {
        type: "application/octet-stream",
      })
    );
    metas.push(result.meta);
  }

  return { files: encrypted, metas };
}

// ─── Rate Limit Toast ───

/**
 * Shows a toast warning if the API response indicates rate limiting.
 * Returns true if rate limited.
 */
export function handleRateLimitError(res: {
  success: boolean;
  error?: string;
}): boolean {
  if (!res.success && res.error?.includes("too many")) {
    useToastStore
      .getState()
      .addToast("warning", i18n.t("chat:tooManyMessages"));
    return true;
  }
  return false;
}

// ─── Typing Indicator ───

const TYPING_TIMEOUT = 5_000;

/**
 * Creates a typing handler with its own timer map.
 * Both messageStore and dmStore use identical typing logic.
 *
 * @param set - Zustand set function with typingUsers field
 */
export function createTypingHandler(
  set: (
    fn: (state: { typingUsers: Record<string, string[]> }) => {
      typingUsers: Record<string, string[]>;
    }
  ) => void
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return (channelId: string, username: string) => {
    set((state) => {
      const current = state.typingUsers[channelId] ?? [];
      if (current.includes(username)) return state as { typingUsers: Record<string, string[]> };

      return {
        typingUsers: {
          ...state.typingUsers,
          [channelId]: [...current, username],
        },
      };
    });

    const key = `${channelId}:${username}`;
    const existingTimer = timers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    timers.set(
      key,
      setTimeout(() => {
        set((state) => ({
          typingUsers: {
            ...state.typingUsers,
            [channelId]: (state.typingUsers[channelId] ?? []).filter(
              (u) => u !== username
            ),
          },
        }));
        timers.delete(key);
      }, TYPING_TIMEOUT)
    );
  };
}

// ─── Generic WS Message Handlers ───

/**
 * Generic message-update handler. Replaces a message by ID in a keyed record.
 * Used by both handleMessageUpdate and handleDMMessageUpdate.
 */
export function updateMessageInRecord<
  T extends { id: string }
>(
  messagesByChannel: Record<string, T[]>,
  channelId: string,
  updatedMessage: T
): Record<string, T[]> {
  const messages = messagesByChannel[channelId];
  if (!messages) return messagesByChannel;

  return {
    ...messagesByChannel,
    [channelId]: messages.map((m) =>
      m.id === updatedMessage.id ? updatedMessage : m
    ),
  };
}

/**
 * Generic message-delete handler. Removes message and nullifies reply references.
 * Used by both handleMessageDelete and handleDMMessageDelete.
 */
export function deleteMessageFromRecord<
  T extends { id: string; reply_to_id?: string | null; referenced_message?: unknown }
>(
  messagesByChannel: Record<string, T[]>,
  channelId: string,
  deletedId: string
): Record<string, T[]> {
  const messages = messagesByChannel[channelId];
  if (!messages) return messagesByChannel;

  const updated = messages
    .filter((m) => m.id !== deletedId)
    .map((m) =>
      m.reply_to_id === deletedId
        ? { ...m, referenced_message: { id: deletedId, author: null, content: null } }
        : m
    );

  return {
    ...messagesByChannel,
    [channelId]: updated,
  };
}

/**
 * Generic reaction-update handler. Replaces reaction list on a message.
 * Used by both handleReactionUpdate and handleDMReactionUpdate.
 */
export function updateReactionInRecord<
  T extends { id: string; reactions?: ReactionGroup[] }
>(
  messagesByChannel: Record<string, T[]>,
  channelId: string,
  messageId: string,
  reactions: ReactionGroup[]
): Record<string, T[]> {
  const messages = messagesByChannel[channelId];
  if (!messages) return messagesByChannel;

  return {
    ...messagesByChannel,
    [channelId]: messages.map((m) =>
      m.id === messageId ? { ...m, reactions } : m
    ),
  };
}

/**
 * Generic author-update handler. Patches author info across all cached messages.
 * Used by both handleAuthorUpdate and handleDMAuthorUpdate.
 *
 * @returns Updated record and whether any change occurred.
 */
export function updateAuthorInRecord<
  T extends { author?: { id: string } | null }
>(
  messagesByChannel: Record<string, T[]>,
  userId: string,
  patch: { display_name?: string | null; avatar_url?: string | null }
): { updated: Record<string, T[]>; changed: boolean } {
  const result: Record<string, T[]> = {};
  let changed = false;

  for (const [chId, msgs] of Object.entries(messagesByChannel)) {
    result[chId] = msgs.map((m) => {
      if (m.author?.id !== userId) return m;
      changed = true;
      return { ...m, author: { ...m.author, ...patch } };
    });
  }

  return { updated: result, changed };
}
