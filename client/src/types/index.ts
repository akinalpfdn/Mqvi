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
  is_platform_admin: boolean;
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
  last_message_at: string | null; // Son mesaj aktivitesi — sıralama için
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
// Platform Admin
// ──────────────────────────────────

/**
 * LiveKitInstanceAdmin — Admin panelde gösterilen LiveKit instance bilgisi.
 * Credential'lar backend'de kalır, sadece URL ve kapasite bilgisi döner.
 */
export type LiveKitInstanceAdmin = {
  id: string;
  url: string;
  is_platform_managed: boolean;
  server_count: number;
  max_servers: number;
  created_at: string;
};

export type CreateLiveKitInstanceRequest = {
  url: string;
  api_key: string;
  api_secret: string;
  max_servers: number;
};

export type UpdateLiveKitInstanceRequest = {
  url?: string;
  api_key?: string;
  api_secret?: string;
  max_servers?: number;
};

/**
 * LiveKitInstanceMetrics — Prometheus /metrics endpoint'inden parse edilen
 * LiveKit instance anlık kaynak kullanım metrikleri.
 */
export type LiveKitInstanceMetrics = {
  goroutines: number;
  memory_used: number;
  room_count: number;
  participant_count: number;
  track_publish_count: number;
  track_subscribe_count: number;
  bytes_in: number;
  bytes_out: number;
  packets_in: number;
  packets_out: number;
  nack_total: number;
  fetched_at: string;
  available: boolean;
};

/**
 * MetricsHistorySummary — Belirli bir zaman aralığı için özetlenmiş
 * tarihsel LiveKit metrik verileri. SQL aggregate ile backend'de hesaplanır.
 */
export type MetricsHistorySummary = {
  period: string;
  sample_count: number;
  peak_participants: number;
  avg_participants: number;
  peak_rooms: number;
  avg_rooms: number;
  peak_memory_bytes: number;
  avg_memory_bytes: number;
  peak_cpu_pct: number;
  avg_cpu_pct: number;
  peak_bandwidth_in_bps: number;
  avg_bandwidth_in_bps: number;
  peak_bandwidth_out_bps: number;
  avg_bandwidth_out_bps: number;
  peak_goroutines: number;
  avg_goroutines: number;
};

/**
 * AdminServerListItem — Platform admin panelde gösterilen sunucu bilgisi.
 * Tek SQL sorgusu ile tüm istatistikler toplanır.
 */
export type AdminServerListItem = {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  owner_username: string;
  created_at: string;
  is_platform_managed: boolean;
  livekit_instance_id: string | null;
  member_count: number;
  channel_count: number;
  message_count: number;
  storage_mb: number;
  last_activity: string | null;
};

/**
 * AdminUserListItem — Platform admin panelde gösterilen kullanıcı bilgisi.
 * Tek SQL sorgusu ile tüm istatistikler toplanır (correlated subquery pattern).
 */
export type AdminUserListItem = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_platform_admin: boolean;
  created_at: string;
  status: string;
  last_activity: string | null;
  message_count: number;
  storage_mb: number;
  owned_self_servers: number;
  owned_mqvi_servers: number;
  member_server_count: number;
  ban_count: number;
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
};

export type AuthTokens = {
  access_token: string;
  refresh_token: string;
  user: User;
};

// ──────────────────────────────────
// Server
// ──────────────────────────────────

/**
 * Server — Tam sunucu bilgisi.
 * Backend'deki models.Server struct'ının TypeScript karşılığı.
 * Multi-server mimaride kullanıcı birden fazla sunucuya üye olabilir.
 */
export type Server = {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  invite_required: boolean;
  livekit_instance_id: string | null;
  member_count: number;
  created_at: string;
};

/**
 * ServerListItem — Sunucu listesinde gösterilen minimal sunucu bilgisi.
 * WS ready event'inde ve GET /api/servers endpoint'inden döner.
 * Tam Server nesnesinden çok daha hafif — sadece sidebar render'ı için yeterli.
 */
export type ServerListItem = {
  id: string;
  name: string;
  icon_url: string | null;
};

/**
 * CreateServerRequest — Yeni sunucu oluşturma isteği.
 *
 * host_type seçenekleri:
 * - "mqvi_hosted": Platformun sağladığı LiveKit instance kullanılır (önerilen)
 * - "self_hosted": Kullanıcı kendi LiveKit URL, API Key ve Secret'ını verir
 */
export type CreateServerRequest = {
  name: string;
  host_type: "mqvi_hosted" | "self_hosted";
  livekit_url?: string;
  livekit_key?: string;
  livekit_secret?: string;
};

/**
 * JoinServerRequest — Davet koduyla sunucuya katılma isteği.
 */
export type JoinServerRequest = {
  invite_code: string;
};
