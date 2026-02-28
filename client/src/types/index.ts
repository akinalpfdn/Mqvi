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
  email: string | null;
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
// Channel Permission Override
// ──────────────────────────────────

/**
 * ChannelPermissionOverride — Kanal bazlı permission override.
 * Backend'deki models.ChannelPermissionOverride struct'ının TypeScript karşılığı.
 *
 * Discord'un override sistemi:
 * - allow: Bu bit'ler role'un varsayılan permission'ına eklenir (izin ver)
 * - deny: Bu bit'ler role'un varsayılan permission'ından çıkarılır (engelle)
 * - İkisi de 0 ise: inherit (role'un varsayılan permission'ı geçerli)
 */
export type ChannelPermissionOverride = {
  channel_id: string;
  role_id: string;
  allow: number;
  deny: number;
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
  display_name: string;
  avatar_url: string;
  is_muted: boolean;
  is_deafened: boolean;
  is_streaming: boolean;
  /** Admin tarafından sunucu genelinde susturulmuş (herkes için) */
  is_server_muted: boolean;
  /** Admin tarafından sunucu genelinde sağırlaştırılmış (herkes için) */
  is_server_deafened: boolean;
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
  display_name: string;
  avatar_url: string;
  is_muted: boolean;
  is_deafened: boolean;
  is_streaming: boolean;
  is_server_muted: boolean;
  is_server_deafened: boolean;
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
  reply_to_id: string | null;
  is_pinned: boolean;
  author: User;
  attachments: DMAttachment[];
  reactions: ReactionGroup[];
  referenced_message: MessageReference | null;
};

/**
 * DMAttachment — DM mesajına eklenmiş dosya.
 * Channel Attachment ile aynı yapı ama dm_message_id kullanır.
 */
export type DMAttachment = {
  id: string;
  dm_message_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
};

/**
 * DMMessagePage — DM mesajları için cursor-based pagination response.
 */
export type DMMessagePage = {
  messages: DMMessage[];
  has_more: boolean;
};

// ──────────────────────────────────
// Friendship
// ──────────────────────────────────

/**
 * FriendshipWithUser — Arkadaşlık kaydı + karşı taraf kullanıcı bilgisi.
 * Backend'deki models.FriendshipWithUser struct'ının TypeScript karşılığı.
 *
 * status:
 * - "pending": İstek gönderildi, henüz kabul edilmedi
 * - "accepted": Arkadaşlık aktif
 */
export type FriendshipWithUser = {
  id: string;
  status: "pending" | "accepted";
  created_at: string;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  user_status: UserStatus;
  user_custom_status: string | null;
};

/**
 * FriendRequestsResponse — Gelen ve giden arkadaşlık istekleri.
 * GET /api/friends/requests endpoint'inden dönen format.
 */
export type FriendRequestsResponse = {
  incoming: FriendshipWithUser[];
  outgoing: FriendshipWithUser[];
};

// ──────────────────────────────────
// P2P Call (WebRTC)
// ──────────────────────────────────

/**
 * P2PCallType — P2P arama türü.
 * - "voice": Sadece sesli arama (mikrofon)
 * - "video": Görüntülü arama (mikrofon + kamera)
 */
export type P2PCallType = "voice" | "video";

/**
 * P2PCallStatus — P2P arama durumu.
 * - "ringing": Arama başlatıldı, karşı taraf henüz yanıtlamadı
 * - "active": Arama kabul edildi, WebRTC bağlantısı aktif
 * - "ended": Arama sonlandırıldı
 */
export type P2PCallStatus = "ringing" | "active" | "ended";

/**
 * P2PCall — Bir P2P aramayı temsil eder.
 * Backend'deki models.P2PCallBroadcast struct'ının TypeScript karşılığı.
 * Hem caller hem receiver bilgilerini taşır — frontend her iki tarafta da
 * karşı tarafın bilgisini gösterir.
 */
export type P2PCall = {
  id: string;
  caller_id: string;
  caller_username: string;
  caller_display_name: string | null;
  caller_avatar: string | null;
  receiver_id: string;
  receiver_username: string;
  receiver_display_name: string | null;
  receiver_avatar: string | null;
  call_type: P2PCallType;
  status: P2PCallStatus;
  created_at: string;
};

/**
 * P2PSignalPayload — WebRTC signaling verisi.
 * SDP offer/answer veya ICE candidate taşır.
 * Server bu veriyi doğrudan karşı tarafa relay eder — içeriğine bakmaz.
 *
 * WebRTC nedir?
 * Tarayıcılar arası doğrudan (peer-to-peer) ses/video iletişimi sağlayan API.
 * Sunucu sadece "signaling" (SDP ve ICE bilgisi alışverişi) için kullanılır.
 * Medya (ses/video) doğrudan kullanıcılar arasında akar.
 */
export type P2PSignalPayload = {
  call_id: string;
  type: "offer" | "answer" | "ice-candidate";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
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
  email?: string;
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
