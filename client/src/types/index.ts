/**
 * Application-wide TypeScript types.
 * Mirrors backend Go structs. Naming: PascalCase, no "I" prefix.
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
  has_seen_download_prompt: boolean;
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

/** Grouped structure returned by GET /api/channels. */
export type CategoryWithChannels = {
  category: Category;
  channels: Channel[];
};

// ──────────────────────────────────
// Reaction
// ──────────────────────────────────

/** Grouped emoji reaction info. */
export type ReactionGroup = {
  emoji: string;
  count: number;
  users: string[]; // user IDs
};

// ──────────────────────────────────
// Channel Permission Override
// ──────────────────────────────────

/**
 * Discord-style channel permission override.
 * - allow: bits added to role's default permissions
 * - deny: bits removed from role's default permissions
 * - Both 0: inherit (role defaults apply)
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
 * Reply preview info. If the referenced message was deleted,
 * author and content are null ("Original message was deleted").
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
  /** Transient — set by backend on WS broadcast for cross-server notification routing */
  server_id?: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  reply_to_id: string | null;
  referenced_message: MessageReference | null;
  author: User;
  attachments: Attachment[];
  mentions: string[];
  role_mentions: string[];
  reactions: ReactionGroup[];
  encryption_version: EncryptionVersion; // 0=plaintext, 1=E2EE
  ciphertext?: string | null;
  sender_device_id?: string | null;
  e2ee_metadata?: string | null;
  /** Client-only: decrypted file keys */
  e2ee_file_keys?: import("../crypto/fileEncryption").EncryptedFileMeta[];
};

export type Attachment = {
  id: string;
  message_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
};

/** Cursor-based pagination response. */
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
  is_owner: boolean;
  mentionable: boolean;
};

// ──────────────────────────────────
// Member (User + Roles)
// ──────────────────────────────────

/** Member info with roles and computed effective_permissions. */
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

/** Badge template created by the badge admin. */
export type Badge = {
  id: string;
  name: string;
  icon: string;
  icon_type: "builtin" | "custom";
  color1: string;
  color2: string | null;
  created_by: string;
  created_at: string;
};

/** A badge assigned to a specific user. */
export type UserBadge = {
  id: string;
  user_id: string;
  badge_id: string;
  assigned_by: string;
  assigned_at: string;
  badge?: Badge;
};

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

/** Pinned message with full message data and pinner info. */
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

/** Ephemeral voice state (in-memory only, not persisted to DB). */
export type VoiceState = {
  user_id: string;
  channel_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  is_muted: boolean;
  is_deafened: boolean;
  is_streaming: boolean;
  /** Server-wide mute by admin */
  is_server_muted: boolean;
  /** Server-wide deafen by admin */
  is_server_deafened: boolean;
};

/** LiveKit token response from POST /api/voice/token. */
export type VoiceTokenResponse = {
  token: string;
  url: string;
  channel_id: string;
  /** Room-level E2EE passphrase (SFrame). Generated server-side. */
  e2ee_passphrase?: string;
};

/** voice_state_update WS event payload. */
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

/** DM channel with the other participant's user info. */
export type DMChannelWithUser = {
  id: string;
  other_user: User;
  e2ee_enabled: boolean;
  created_at: string;
  last_message_at: string | null;
  is_pinned: boolean;
  is_muted: boolean;
};

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
  encryption_version: EncryptionVersion; // 0=plaintext, 1=E2EE
  ciphertext?: string | null;
  sender_device_id?: string | null;
  e2ee_metadata?: string | null;
  /** Client-only: decrypted file keys */
  e2ee_file_keys?: import("../crypto/fileEncryption").EncryptedFileMeta[];
};

export type DMAttachment = {
  id: string;
  dm_message_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
};

export type DMMessagePage = {
  messages: DMMessage[];
  has_more: boolean;
};

// ──────────────────────────────────
// Friendship
// ──────────────────────────────────

/**
 * Friendship record with the other user's info.
 * status: "pending" | "accepted" | "blocked"
 */
export type FriendshipWithUser = {
  id: string;
  status: "pending" | "accepted" | "blocked";
  created_at: string;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  user_status: UserStatus;
  user_custom_status: string | null;
};

export type FriendRequestsResponse = {
  incoming: FriendshipWithUser[];
  outgoing: FriendshipWithUser[];
};

// ──────────────────────────────────
// P2P Call (WebRTC)
// ──────────────────────────────────

export type P2PCallType = "voice" | "video";

export type P2PCallStatus = "ringing" | "active" | "ended";

/** P2P call with both caller and receiver info. */
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
 * WebRTC signaling data (SDP offer/answer or ICE candidate).
 * Server relays this directly to the peer without inspecting contents.
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

/** LiveKit instance info for admin panel (credentials stay on backend). */
export type LiveKitInstanceAdmin = {
  id: string;
  url: string;
  is_platform_managed: boolean;
  server_count: number;
  max_servers: number;
  hetzner_server_id: string;
  created_at: string;
};

export type CreateLiveKitInstanceRequest = {
  url: string;
  api_key: string;
  api_secret: string;
  max_servers: number;
  hetzner_server_id?: string;
};

export type UpdateLiveKitInstanceRequest = {
  url?: string;
  api_key?: string;
  api_secret?: string;
  max_servers?: number;
  hetzner_server_id?: string;
};

/** Parsed Prometheus metrics from LiveKit instance. */
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
  cpu_pct: number;
  bw_in_bps: number;
  bw_out_bps: number;
  hetzner_avail: boolean;
  screen_share_count: number;
  screen_share_viewers: number;
  fetched_at: string;
  available: boolean;
};

/** Aggregated historical metrics for a time period (SQL aggregate). */
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

/** Single time-series data point for charts. */
export type MetricsTimeSeriesPoint = {
  ts: string;
  cpu_pct: number;
  bw_in: number;
  bw_out: number;
  participants: number;
  memory_bytes: number;
  screen_shares: number;
};

/** Server info for platform admin panel (single SQL query with stats). */
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

/** User info for platform admin panel (correlated subquery pattern). */
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
  is_platform_banned: boolean;
};

// ──────────────────────────────────
// Admin Reports
// ──────────────────────────────────
export type ReportAttachment = {
  id: string;
  report_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
};

export type AdminReportListItem = {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: string;
  description: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  reporter_username: string;
  reporter_display_name: string | null;
  reported_username: string;
  reported_display_name: string | null;
  attachments: ReportAttachment[];
};

// ──────────────────────────────────
// App Logs (Admin)
// ──────────────────────────────────
export type AppLogLevel = "error" | "warn" | "info";
export type AppLogCategory = "voice" | "video" | "screen_share" | "ws" | "auth" | "general";

export type AppLog = {
  id: string;
  level: AppLogLevel;
  category: AppLogCategory;
  user_id: string | null;
  server_id: string | null;
  message: string;
  metadata: string;
  created_at: string;
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

export type Server = {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  invite_required: boolean;
  e2ee_enabled: boolean;
  livekit_instance_id: string | null;
  afk_timeout_minutes: number;
  member_count: number;
  created_at: string;
};

/** Lightweight server info for sidebar rendering (WS ready + GET /api/servers). */
export type ServerListItem = {
  id: string;
  name: string;
  icon_url: string | null;
};

/**
 * host_type:
 * - "mqvi_hosted": Platform-managed LiveKit instance
 * - "self_hosted": User provides their own LiveKit URL/key/secret
 */
export type CreateServerRequest = {
  name: string;
  host_type: "mqvi_hosted" | "self_hosted";
  livekit_url?: string;
  livekit_key?: string;
  livekit_secret?: string;
};

export type JoinServerRequest = {
  invite_code: string;
};

// ──────────────────────────────────
// E2EE (End-to-End Encryption)
// ──────────────────────────────────

/** 0 = plaintext (legacy), 1 = E2EE (Signal Protocol / Sender Key) */
export type EncryptionVersion = 0 | 1;

/** Own device info (full detail) from GET /api/devices. */
export type DeviceInfo = {
  id: string;
  user_id: string;
  device_id: string;
  display_name: string | null;
  identity_key: string;
  signed_prekey: string;
  signed_prekey_id: number;
  signed_prekey_signature: string;
  registration_id: number;
  last_seen_at: string;
  created_at: string;
};

/** Public device info visible to other users (no private keys). */
export type DevicePublicInfo = {
  device_id: string;
  display_name: string | null;
  identity_key: string;
  created_at: string;
  last_seen_at: string;
};

/**
 * X3DH prekey bundle for establishing shared secret.
 * one_time_prekey can be null if pool is exhausted (falls back to 3-DH).
 */
export type PreKeyBundleResponse = {
  device_id: string;
  registration_id: number;
  identity_key: string;
  signing_key: string | null;       // Ed25519 public — for signed prekey verification
  signed_prekey_id: number;
  signed_prekey: string;
  signed_prekey_signature: string;
  one_time_prekey_id: number | null;
  one_time_prekey: string | null;
};

/** Encrypted key backup stored on server. */
export type KeyBackupResponse = {
  id: string;
  user_id: string;
  version: number;
  algorithm: string;
  encrypted_data: string;
  nonce: string;
  salt: string;
  created_at: string;
  updated_at: string;
};

/** Channel Sender Key group session. */
export type ChannelGroupSessionResponse = {
  id: string;
  channel_id: string;
  sender_user_id: string;
  sender_device_id: string;
  session_id: string;
  session_data: string;
  message_index: number;
  created_at: string;
};

/** Per-device encrypted envelope for DM (Signal Protocol). */
export type EncryptedEnvelope = {
  sender_device_id: string;
  recipient_device_id?: string;
  message_type: number;   // 2=Whisper, 3=PreKey
  ciphertext: string;     // base64 encoded
};

/** Sender Key envelope for group messages (single ciphertext for all members). */
export type SenderKeyEnvelope = {
  sender_device_id: string;
  distribution_id: string;
  ciphertext: string;     // base64 encoded
};

/** Full E2EE message payload parsed from JSON body in handler layer. */
export type EncryptedMessagePayload = {
  encryption_version: 1;
  sender_device_id: string;
  encrypted_content: EncryptedEnvelope[] | SenderKeyEnvelope;
  mentions: string[];
  reply_to_id?: string;
};

/** Encrypted file metadata (included in encrypted payload — server cannot see). */
export type EncryptedAttachmentMeta = {
  key: string;           // AES-256-GCM key (base64)
  iv: string;            // Initialization vector (base64)
  filename: string;
  mime_type: string;
  original_size: number;
  digest: string;        // SHA-256 hash (hex)
};

/** URL Open Graph metadata (server-side fetch with SSRF protection). */
export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  favicon_url: string | null;
};
