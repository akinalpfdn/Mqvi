/**
 * ChatContext — Channel ve DM chat arasında paylaşılan bileşen arayüzü.
 *
 * Neden Context?
 * Message.tsx, MessageInput.tsx, MessageList.tsx gibi bileşenler doğrudan
 * useMessageStore, usePinStore, useMemberStore import ediyordu.
 * Bu, aynı bileşenlerin DM'de kullanılmasını engelliyordu çünkü
 * DM farklı store'lar kullanıyor (useDMStore).
 *
 * ChatContext, store farklılıklarını soyutlar:
 * - ChannelChatProvider → messageStore, pinStore, memberStore → ChatContext
 * - DMChatProvider     → dmStore                              → ChatContext
 * - Shared components  → useChatContext() ile tek interface
 *
 * Bu SOLID'in Dependency Inversion (DIP) prensibidir:
 * Component'ler concrete store'lara değil, abstract interface'e bağımlı olur.
 *
 * ChatMessage tipi:
 * Structural subtyping kullanılır. Hem Message hem DMMessage, ChatMessage'ın
 * tüm alanlarına sahiptir (+ ek alanlar). TypeScript bunu otomatik kabul eder
 * çünkü "fazla alan varsa sorun değil" kuralı geçerlidir.
 */

import { createContext, useContext, type RefObject } from "react";
import type { User, ReactionGroup, MessageReference, MemberWithRoles } from "../types";

// ─── ChatMessage — Ortak mesaj tipi ───
// Message ve DMMessage'ın display-relevant kesişimi.
// message_id vs dm_message_id gibi farklar burada yok —
// component'ler sadece render için gereken alanlara erişir.

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
};

// ─── Context Value ───

export type ChatContextValue = {
  /** "channel" veya "dm" — component'lerin mode'a göre davranış değiştirmesi için */
  mode: "channel" | "dm";
  /** Aktif kanal/DM kanal ID'si */
  channelId: string;
  /** Kanal adı veya karşı kullanıcının adı */
  channelName: string;

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

  // ─── File Drop (drag-drop communication) ───
  /**
   * addFilesRef — Chat area wrapper'dan MessageInput'a dosya iletimi için ref.
   * MessageInput mount olunca callback'i register eder,
   * ChatArea/DMChat drag-drop'ta çağırır.
   */
  addFilesRef: RefObject<((files: File[]) => void) | null>;

  // ─── Permissions / UI ───
  /** Kullanıcının bu kanalda mesaj gönderme yetkisi var mı? */
  canSend: boolean;
  /** Kullanıcının mesajları yönetme (pin, başkasının mesajını silme) yetkisi var mı? */
  canManageMessages: boolean;
  /** Rol renklerini göster mi? (Channel: evet, DM: hayır) */
  showRoleColors: boolean;
  /** Üye listesi — DM'de boş array */
  members: MemberWithRoles[];
};

// ─── Context ───

const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * useChatContext — ChatContext'e erişim hook'u.
 *
 * ChannelChatProvider veya DMChatProvider içinde çağrılmalıdır.
 * Provider dışında çağrılırsa hata fırlatır.
 */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return ctx;
}

export { ChatContext };
