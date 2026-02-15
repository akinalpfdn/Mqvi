/**
 * Uygulama genelinde kullanılan TypeScript tipleri.
 *
 * TypeScript'te "type" ve "interface" veri şekillerini tanımlar.
 * Frontend ve backend aynı veri yapılarını paylaşır —
 * bu dosya backend'deki Go struct'larının TypeScript karşılığıdır.
 *
 * Naming convention: PascalCase, "I" prefix yok.
 */

// ──────────────────────────────────
// User
// ──────────────────────────────────
export type UserStatus = "online" | "idle" | "dnd" | "offline";

export type User = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: UserStatus;
  custom_status: string | null;
  language: string;
  created_at: string;
};

// ──────────────────────────────────
// Channel
// ──────────────────────────────────
export type ChannelType = "text" | "voice";

export type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  category_id: string | null;
  topic: string | null;
  position: number;
  user_limit: number;
  bitrate: number;
  created_at: string;
};

// ──────────────────────────────────
// Category
// ──────────────────────────────────
export type Category = {
  id: string;
  name: string;
  position: number;
};

/**
 * CategoryWithChannels — Sidebar'da kullanılan gruplu yapı.
 * Backend GET /api/channels endpoint'i bu formatta döner.
 */
export type CategoryWithChannels = {
  category: Category;
  channels: Channel[];
};

// ──────────────────────────────────
// Reaction
// ──────────────────────────────────

/**
 * ReactionGroup — Gruplanmış emoji tepki bilgisi.
 * Backend'deki models.ReactionGroup struct'ının TypeScript karşılığı.
 * Aynı emojiye tepki veren kullanıcıları ve toplam sayıyı içerir.
 */
export type ReactionGroup = {
  emoji: string;
  count: number;
  users: string[]; // user ID'leri
};

// ──────────────────────────────────
// Message
// ──────────────────────────────────

/**
 * MessageReference — Yanıt yapılan mesajın ön izleme bilgisi.
 * Backend'deki models.MessageReference struct'ının TypeScript karşılığı.
 *
 * Referans mesaj silinmişse author ve content null olur —
 * bu durumda frontend "Orijinal mesaj silindi" gösterir.
 */
export type MessageReference = {
  id: string;
  author: User | null;
  content: string | null;
};

export type Message = {
  id: string;
  channel_id: string;
  user_id: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  reply_to_id: string | null;
  referenced_message: MessageReference | null;
  author: User;
  attachments: Attachment[];
  mentions: string[];  // Mesajda bahsedilen kullanıcı ID'leri (@username parse sonucu)
  reactions: ReactionGroup[];  // Emoji tepkileri (gruplanmış)
};

export type Attachment = {
  id: string;
  message_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
};

/**
 * MessagePage — Cursor-based pagination response.
 * Backend GET /api/channels/{id}/messages endpoint'i bu formatta döner.
 */
export type MessagePage = {
  messages: Message[];
  has_more: boolean;
};

// ──────────────────────────────────
// Role
// ──────────────────────────────────
export type Role = {
  id: string;
  name: string;
  color: string;
  position: number;
  permissions: number;
  is_default: boolean;
};

// ──────────────────────────────────
// Member (User + Roles)
// ──────────────────────────────────

/**
 * MemberWithRoles — Üye bilgileri + rolleri + hesaplanmış yetkileri.
 *
 * Backend'deki models.MemberWithRoles struct'ının TypeScript karşılığı.
 * Rol hiyerarşisi ve permission kontrolü için effective_permissions kullanılır.
 */
export type MemberWithRoles = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: UserStatus;
  custom_status: string | null;
  created_at: string;
  roles: Role[];
  effective_permissions: number;
};

/**
 * Ban — Yasaklanmış kullanıcı bilgisi.
 */
export type Ban = {
  user_id: string;
  username: string;
  reason: string;
  banned_by: string;
  created_at: string;
};

// ──────────────────────────────────
// Invite
// ──────────────────────────────────
export type Invite = {
  code: string;
  created_by: string | null;
  max_uses: number;
  uses: number;
  expires_at: string | null;
  created_at: string;
  creator_username: string;
  creator_display_name: string | null;
};

// ──────────────────────────────────
// Pin
// ──────────────────────────────────

/**
 * PinnedMessage — Sabitlenmiş mesaj bilgisi.
 * Backend'deki models.PinnedMessageWithDetails struct'ının TypeScript karşılığı.
 * Pin bilgisi + mesajın kendisi + pinleyen kullanıcı bir arada döner.
 */
export type PinnedMessage = {
  id: string;
  message_id: string;
  channel_id: string;
  pinned_by: string;
  created_at: string;
  message: Message;
  pinned_by_user: User | null;
};

// ──────────────────────────────────
// Voice
// ──────────────────────────────────

/**
 * VoiceState — Bir kullanıcının ses kanalındaki anlık durumu.
 * Backend'deki models.VoiceState struct'ının TypeScript karşılığı.
 * Ephemeral (geçici) veridir — DB'ye yazılmaz.
 */
export type VoiceState = {
  user_id: string;
  channel_id: string;
  username: string;
  avatar_url: string;
  is_muted: boolean;
  is_deafened: boolean;
  is_streaming: boolean;
};

/**
 * VoiceTokenResponse — LiveKit token generation yanıtı.
 * POST /api/voice/token endpoint'inden döner.
 * Client bu bilgilerle doğrudan LiveKit sunucusuna bağlanır.
 */
export type VoiceTokenResponse = {
  token: string;
  url: string;
  channel_id: string;
};

/**
 * VoiceStateUpdateData — voice_state_update WS event payload'ı.
 * Bir kullanıcının ses durumu değiştiğinde tüm client'lara broadcast edilir.
 * action alanı değişikliğin türünü belirtir.
 */
export type VoiceStateUpdateData = {
  user_id: string;
  channel_id: string;
  username: string;
  avatar_url: string;
  is_muted: boolean;
  is_deafened: boolean;
  is_streaming: boolean;
  action: "join" | "leave" | "update";
};

// ──────────────────────────────────
// DM (Direct Messages)
// ──────────────────────────────────

/**
 * DMChannelWithUser — DM kanal bilgisi + karşı taraf kullanıcı bilgisi.
 * Backend'den dönen format — hangi kullanıcıyla konuştuğunu gösterir.
 */
export type DMChannelWithUser = {
  id: string;
  other_user: User;
  created_at: string;
};

/**
 * DMMessage — Bir DM mesajını temsil eder.
 * Server mesajlarıyla benzer yapıda.
 */
export type DMMessage = {
  id: string;
  dm_channel_id: string;
  user_id: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  author: User;
};

/**
 * DMMessagePage — DM mesajları için cursor-based pagination response.
 */
export type DMMessagePage = {
  messages: DMMessage[];
  has_more: boolean;
};

// ──────────────────────────────────
// WebSocket
// ──────────────────────────────────
export type WSMessage = {
  op: string;
  d: unknown;
  seq?: number;
};

// ──────────────────────────────────
// API Response
// ──────────────────────────────────
export type APIResponse<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
};

// ──────────────────────────────────
// Auth
// ──────────────────────────────────
export type LoginRequest = {
  username: string;
  password: string;
};

export type RegisterRequest = {
  username: string;
  password: string;
  display_name?: string;
  invite_code?: string;
};

export type AuthTokens = {
  access_token: string;
  refresh_token: string;
  user: User;
};

// ──────────────────────────────────
// Server
// ──────────────────────────────────
export type Server = {
  id: string;
  name: string;
  icon_url: string | null;
  invite_required: boolean;
  member_count: number;
};
