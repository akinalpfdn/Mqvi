/**
 * ChatContext — Shared interface between Channel and DM chat components.
 *
 * Abstracts store differences so shared components (Message, MessageInput, etc.)
 * work with both channel and DM modes via a single interface (DIP).
 *
 * ChatMessage uses structural subtyping — both Message and DMMessage satisfy it.
 */

import { createContext, useContext, type RefObject } from "react";
import type { User, ReactionGroup, MessageReference, MemberWithRoles } from "../types";
import type { EncryptedFileMeta } from "../crypto/fileEncryption";

// ─── ChatMessage — Common message type ───
// Display-relevant intersection of Message and DMMessage.

export type ChatAttachment = {
  id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
};

export type ChatMessage = {
  id: string;
  user_id: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  reply_to_id: string | null;
  is_pinned: boolean;
  author: User;
  attachments: ChatAttachment[];
  reactions: ReactionGroup[];
  referenced_message: MessageReference | null;
  /** User IDs mentioned in this message */
  mentions?: string[];
  /** Role IDs mentioned in this message */
  role_mentions?: string[];
  /** E2EE: 0 = plaintext, 1 = encrypted */
  encryption_version?: number;
  /** E2EE: File encryption keys (index-matched to attachments) */
  e2ee_file_keys?: EncryptedFileMeta[];
};

// ─── Context Value ───

export type ChatContextValue = {
  mode: "channel" | "dm";
  channelId: string;
  channelName: string;
  /** Server ID this channel belongs to (undefined for DMs) */
  serverId?: string;

  // ─── State ───
  messages: ChatMessage[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  replyingTo: ChatMessage | null;
  scrollToMessageId: string | null;
  typingUsers: string[];

  // ─── Message Actions ───
  sendMessage: (content: string, files?: File[], replyToId?: string) => Promise<boolean>;
  editMessage: (id: string, content: string) => Promise<boolean>;
  deleteMessage: (id: string) => Promise<boolean>;
  fetchMessages: () => Promise<void>;
  fetchOlderMessages: () => Promise<void>;

  // ─── Reaction ───
  toggleReaction: (messageId: string, emoji: string) => void;

  // ─── Reply ───
  setReplyingTo: (msg: ChatMessage | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Typing ───
  sendTyping: () => void;

  // ─── Pin ───
  pinMessage: (messageId: string) => Promise<void>;
  unpinMessage: (messageId: string) => Promise<void>;
  isMessagePinned: (messageId: string) => boolean;

  // ─── File Drop ───
  /** Ref for passing dropped files from ChatArea to MessageInput */
  addFilesRef: RefObject<((files: File[]) => void) | null>;

  // ─── Permissions / UI ───
  canSend: boolean;
  canManageMessages: boolean;
  showRoleColors: boolean;
  members: MemberWithRoles[];
};

// ─── Context ───

const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * useChatContext — Must be called within ChannelChatProvider or DMChatProvider.
 * Throws if used outside a provider.
 */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return ctx;
}

export { ChatContext };
