-- 001_init.sql
-- Temel veritabanı şeması: users, channels, messages ve ilişkili tablolar.
-- Her migration idempotent olmalı: IF NOT EXISTS kullanarak tekrar çalıştırılabilir.

-- WAL mode: Write-Ahead Logging — SQLite'ın eşzamanlı okuma/yazma performansını artırır.
-- Normal modda yazma sırasında tüm DB kilitlenir, WAL modunda okumalar yazma sırasında da devam eder.
PRAGMA journal_mode=WAL;

-- Foreign key desteğini aç — SQLite'ta varsayılan olarak KAPALI gelir!
PRAGMA foreign_keys=ON;

-- Sunucu (her deployment bir sunucu)
CREATE TABLE IF NOT EXISTS server (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    icon_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Kullanıcılar
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    password_hash TEXT NOT NULL,
    status TEXT DEFAULT 'offline' CHECK(status IN ('online', 'idle', 'dnd', 'offline')),
    custom_status TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Roller
CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    color TEXT DEFAULT '#99AAB5',
    position INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Permission bits:
--   1   = MANAGE_CHANNELS
--   2   = MANAGE_ROLES
--   4   = KICK_MEMBERS
--   8   = BAN_MEMBERS
--   16  = MANAGE_MESSAGES
--   32  = SEND_MESSAGES
--   64  = CONNECT_VOICE
--   128 = SPEAK
--   256 = STREAM (screen share)
--   512 = ADMIN (tüm yetkiler)

-- Kullanıcı-Rol ilişkisi (many-to-many)
CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- Kategoriler (channel grouping — Discord'taki "TEXT CHANNELS", "VOICE CHANNELS" gibi)
CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Kanallar (text + voice)
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice')),
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    topic TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    user_limit INTEGER DEFAULT 0,
    bitrate INTEGER DEFAULT 64000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Kanal bazlı yetki override (Discord'taki per-channel permission override)
CREATE TABLE IF NOT EXISTS channel_permissions (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    allow INTEGER NOT NULL DEFAULT 0,
    deny INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, role_id)
);

-- Mesajlar
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    edited_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Dosya ekleri
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Davet kodları
CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    max_uses INTEGER DEFAULT 0,
    uses INTEGER DEFAULT 0,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Oturum takibi (JWT refresh token)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Performance indexleri
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_channels_category ON channels(category_id, position);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(refresh_token);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
