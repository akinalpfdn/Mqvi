-- 003_bans.sql
-- Ban system: table of banned users.
--
-- A row is created here when a user is banned.
-- This table is checked during login and on WS connect.
-- Unban = row is deleted.

CREATE TABLE IF NOT EXISTS bans (
    user_id    TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    reason     TEXT DEFAULT '',
    banned_by  TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
