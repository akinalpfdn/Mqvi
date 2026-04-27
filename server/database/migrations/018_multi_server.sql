-- 018_multi_server.sql
-- Migration from single-server to multi-server architecture.
--
-- Changes:
-- 1. "server" table → "servers" (owner_id, livekit_instance_id added)
-- 2. New: livekit_instances (per-server LiveKit SFU mapping)
-- 3. New: server_members (user ↔ server membership table)
-- 4. server_id added to existing tables: roles, categories, channels, invites, user_roles
-- 5. bans table rebuilt: PK (user_id) → PK (server_id, user_id)
-- 6. Existing data assigned to the "default" server — no data loss.
--
-- IDEMPOTENT: This migration can be re-run even if a previous attempt was partially applied.
-- The migration runner executes each statement separately and tolerates recoverable
-- errors like "duplicate column name" (execStatements).
-- CREATE IF NOT EXISTS + INSERT OR IGNORE + DROP IF EXISTS are already idempotent.

-- ═══════════════════════════════════════════════════════════
-- 1. livekit_instances table (created before servers due to FK dependency)
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
-- 2. "server" → "servers" table (owner_id + livekit_instance_id)
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

-- The old "server" table may have been dropped by a partially-applied migration.
-- Create a placeholder so the INSERT does not error (returns 0 rows;
-- INSERT OR IGNORE preserves existing data).
CREATE TABLE IF NOT EXISTS server (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    icon_url TEXT,
    invite_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Migrate the existing "default" server. owner = the oldest user.
-- On a fresh install (users empty) nothing is migrated; the first user
-- to register will create their own server via CreateServer.
-- INSERT OR IGNORE: does not re-insert if already copied.
INSERT OR IGNORE INTO servers (id, name, icon_url, owner_id, invite_required, created_at)
SELECT s.id, s.name, s.icon_url,
       (SELECT u.id FROM users u ORDER BY u.created_at ASC LIMIT 1),
       s.invite_required,
       s.created_at
FROM server s
WHERE EXISTS (SELECT 1 FROM users);

-- Drop the old "server" table ("servers" is used from now on)
DROP TABLE IF EXISTS server;

-- ═══════════════════════════════════════════════════════════
-- 3. server_members table (user ↔ server membership)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id)
);

-- Make every existing user a member of the "default" server
INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at)
SELECT 'default', u.id, u.created_at FROM users u;

-- ═══════════════════════════════════════════════════════════
-- 4. Add server_id column to existing tables (ALTER TABLE ADD COLUMN)
--
-- Note: SQLite ALTER TABLE ADD COLUMN limitations:
-- - REFERENCES + DEFAULT cannot be combined → REFERENCES omitted
-- - A "duplicate column name" error is raised if the column already exists
--   → the migration runner tolerates this (recoverable error)
-- This ensures a partially-applied migration can be safely re-run.
-- ═══════════════════════════════════════════════════════════

-- roles: each role belongs to one server
ALTER TABLE roles ADD COLUMN server_id TEXT DEFAULT 'default';

-- categories: each category belongs to one server
ALTER TABLE categories ADD COLUMN server_id TEXT DEFAULT 'default';

-- channels: each channel belongs to one server
ALTER TABLE channels ADD COLUMN server_id TEXT DEFAULT 'default';

-- invites: each invite belongs to one server
ALTER TABLE invites ADD COLUMN server_id TEXT DEFAULT 'default';

-- user_roles: which server this role assignment is for
ALTER TABLE user_roles ADD COLUMN server_id TEXT DEFAULT 'default';

-- Fill NULL values with 'default' (DEFAULT applies only to new rows;
-- existing rows remain NULL — fixed up via UPDATE)
UPDATE roles SET server_id = 'default' WHERE server_id IS NULL;
UPDATE categories SET server_id = 'default' WHERE server_id IS NULL;
UPDATE channels SET server_id = 'default' WHERE server_id IS NULL;
UPDATE invites SET server_id = 'default' WHERE server_id IS NULL;
UPDATE user_roles SET server_id = 'default' WHERE server_id IS NULL;

-- On a fresh install the legacy 'default' server was not migrated to "servers"
-- (no users existed), so the seed rows from 002_seed.sql are orphaned. Drop
-- them — the first user to register will create their own server.
DELETE FROM roles      WHERE server_id = 'default' AND NOT EXISTS (SELECT 1 FROM servers WHERE id = 'default');
DELETE FROM categories WHERE server_id = 'default' AND NOT EXISTS (SELECT 1 FROM servers WHERE id = 'default');
DELETE FROM channels   WHERE server_id = 'default' AND NOT EXISTS (SELECT 1 FROM servers WHERE id = 'default');

-- ═══════════════════════════════════════════════════════════
-- 5. Rebuild bans table (PK change: user_id → server_id + user_id)
-- ═══════════════════════════════════════════════════════════

-- Placeholder: the bans table may have been dropped by a partially-applied migration.
-- bans_new may exist while bans does not (rename never happened).
-- Create an empty placeholder so the INSERT below does not error.
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

-- Migrate existing ban data (the old bans table had no server_id)
INSERT OR IGNORE INTO bans_new (server_id, user_id, username, reason, banned_by, created_at)
SELECT 'default', b.user_id, b.username, b.reason, b.banned_by, b.created_at
FROM bans b;

DROP TABLE IF EXISTS bans;
ALTER TABLE bans_new RENAME TO bans;

-- ═══════════════════════════════════════════════════════════
-- 6. Indexes
-- ═══════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);
CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id);
CREATE INDEX IF NOT EXISTS idx_categories_server ON categories(server_id);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id);
CREATE INDEX IF NOT EXISTS idx_bans_server ON bans(server_id, user_id);
CREATE INDEX IF NOT EXISTS idx_livekit_instances_platform ON livekit_instances(is_platform_managed);
