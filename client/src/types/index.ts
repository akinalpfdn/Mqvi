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

// ──────────────────────────────────
// Message
// ──────────────────────────────────
export type Message = {
  id: string;
  channel_id: string;
  user_id: string;
  content: string | null;
  edited_at: string | null;
  created_at: string;
  author: User;
  attachments: Attachment[];
};

export type Attachment = {
  id: string;
  message_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
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
// Invite
// ──────────────────────────────────
export type Invite = {
  code: string;
  created_by: string | null;
  max_uses: number;
  uses: number;
  expires_at: string | null;
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
  member_count: number;
};
