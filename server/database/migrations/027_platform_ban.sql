-- 027_platform_ban.sql
-- Platform-level ban: tüm login, WS connect ve email re-registration'ı bloklar.
-- Server-scoped ban'lerden (bans tablosu) farklıdır — platform genelinde geçerli.

ALTER TABLE users ADD COLUMN is_platform_banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN platform_ban_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN platform_banned_by TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN platform_banned_at DATETIME;
