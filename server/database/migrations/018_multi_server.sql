-- 018_multi_server.sql
-- Tek sunucudan çoklu sunucu mimarisine geçiş.
--
-- Değişiklikler:
-- 1. "server" tablosu → "servers" (owner_id, livekit_instance_id eklendi)
-- 2. Yeni: livekit_instances (per-server LiveKit SFU mapping)
-- 3. Yeni: server_members (kullanıcı ↔ sunucu üyelik tablosu)
-- 4. Mevcut tablolara server_id eklendi: roles, categories, channels, invites, user_roles
-- 5. bans tablosu yeniden oluşturuldu: PK (user_id) → PK (server_id, user_id)
-- 6. Mevcut veriler "default" sunucuya atandı, veri kaybı yok.
--
-- İDEMPOTENT: Bu migration yarım kalsa bile tekrar çalıştırılabilir.
-- Migration runner her statement'ı ayrı çalıştırır ve "duplicate column name"
-- gibi recoverable hataları tolere eder (execStatements).
-- CREATE IF NOT EXISTS + INSERT OR IGNORE + DROP IF EXISTS zaten idempotent.

-- ═══════════════════════════════════════════════════════════
-- 1. livekit_instances tablosu (sunuculardan önce, FK bağımlılığı)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS livekit_instances (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    is_platform_managed INTEGER NOT NULL DEFAULT 0,
    server_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════
-- 2. "server" → "servers" tablosu (owner_id + livekit_instance_id)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_url TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    invite_required INTEGER NOT NULL DEFAULT 0,
    livekit_instance_id TEXT REFERENCES livekit_instances(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Eski "server" tablosu yarım kalan migration'da silinmiş olabilir.
-- Placeholder oluştur ki INSERT hata vermesin (0 satır döner,
-- INSERT OR IGNORE mevcut veriyi korur).
CREATE TABLE IF NOT EXISTS server (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    icon_url TEXT,
    invite_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Mevcut "default" sunucuyu taşı. owner = en eski kullanıcı.
-- INSERT OR IGNORE: Zaten kopyalanmışsa tekrar eklemez.
INSERT OR IGNORE INTO servers (id, name, icon_url, owner_id, invite_required, created_at)
SELECT s.id, s.name, s.icon_url,
       COALESCE(
           (SELECT u.id FROM users u ORDER BY u.created_at ASC LIMIT 1),
           'system'
       ),
       s.invite_required,
       s.created_at
FROM server s;

-- Eski "server" tablosunu sil (artık "servers" kullanılacak)
DROP TABLE IF EXISTS server;

-- ═══════════════════════════════════════════════════════════
-- 3. server_members tablosu (kullanıcı ↔ sunucu üyeliği)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id)
);

-- Mevcut tüm kullanıcıları "default" sunucuya üye yap
INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at)
SELECT 'default', u.id, u.created_at FROM users u;

-- ═══════════════════════════════════════════════════════════
-- 4. Mevcut tablolara server_id kolonu ekle (ALTER TABLE ADD COLUMN)
--
-- Not: SQLite ALTER TABLE ADD COLUMN kısıtlamaları:
-- - REFERENCES + DEFAULT birlikte kullanılamaz → REFERENCES kaldırıldı
-- - "duplicate column name" hatası kolon zaten varsa verilir
--   → migration runner bu hatayı tolere eder (recoverable error)
-- Bu sayede yarım kalan migration güvenle tekrar çalıştırılabilir.
-- ═══════════════════════════════════════════════════════════

-- roles: her rol bir sunucuya ait
ALTER TABLE roles ADD COLUMN server_id TEXT DEFAULT 'default';

-- categories: her kategori bir sunucuya ait
ALTER TABLE categories ADD COLUMN server_id TEXT DEFAULT 'default';

-- channels: her kanal bir sunucuya ait
ALTER TABLE channels ADD COLUMN server_id TEXT DEFAULT 'default';

-- invites: her davet bir sunucuya ait
ALTER TABLE invites ADD COLUMN server_id TEXT DEFAULT 'default';

-- user_roles: hangi sunucudaki rol
ALTER TABLE user_roles ADD COLUMN server_id TEXT DEFAULT 'default';

-- NULL değerleri 'default' ile doldur (DEFAULT sadece yeni satırlara uygulanır,
-- mevcut satırlar NULL kalır — UPDATE ile düzeltiyoruz)
UPDATE roles SET server_id = 'default' WHERE server_id IS NULL;
UPDATE categories SET server_id = 'default' WHERE server_id IS NULL;
UPDATE channels SET server_id = 'default' WHERE server_id IS NULL;
UPDATE invites SET server_id = 'default' WHERE server_id IS NULL;
UPDATE user_roles SET server_id = 'default' WHERE server_id IS NULL;

-- ═══════════════════════════════════════════════════════════
-- 5. bans tablosu yeniden oluştur (PK değişikliği: user_id → server_id + user_id)
-- ═══════════════════════════════════════════════════════════

-- Placeholder: bans tablosu yarım kalan migration'da silinmiş olabilir.
-- bans_new zaten var ama rename yapılamamışsa, bans yoktur.
-- Bu durumda boş bir placeholder oluşturulur ki INSERT hata vermesin.
CREATE TABLE IF NOT EXISTS bans (
    user_id    TEXT PRIMARY KEY,
    username   TEXT NOT NULL DEFAULT '',
    reason     TEXT DEFAULT '',
    banned_by  TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bans_new (
    server_id  TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    username   TEXT NOT NULL DEFAULT '',
    reason     TEXT DEFAULT '',
    banned_by  TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id)
);

-- Mevcut ban verilerini taşı (eski bans tablosunda server_id yoktu)
INSERT OR IGNORE INTO bans_new (server_id, user_id, username, reason, banned_by, created_at)
SELECT 'default', b.user_id, b.username, b.reason, b.banned_by, b.created_at
FROM bans b;

DROP TABLE IF EXISTS bans;
ALTER TABLE bans_new RENAME TO bans;

-- ═══════════════════════════════════════════════════════════
-- 6. İndeksler
-- ═══════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);
CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id);
CREATE INDEX IF NOT EXISTS idx_categories_server ON categories(server_id);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id);
CREATE INDEX IF NOT EXISTS idx_bans_server ON bans(server_id, user_id);
CREATE INDEX IF NOT EXISTS idx_livekit_instances_platform ON livekit_instances(is_platform_managed);
