-- 027_platform_ban.sql
-- Platform-level ban: blocks all login, WS connect and email re-registration.
-- Different from server-scoped bans (bans table) — applies platform-wide.

ALTER TABLE users ADD COLUMN is_platform_banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN platform_ban_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN platform_banned_by TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN platform_banned_at DATETIME;
