-- 020_platform_admin.sql
-- Platform admin flag + multi-instance LiveKit capacity support.
--
-- is_platform_admin: Platform administrator flag.
-- Assigned manually via SQL: UPDATE users SET is_platform_admin = 1 WHERE id = '...';
--
-- max_servers: Maximum server capacity per LiveKit instance.
-- 0 = unlimited (existing instances are not affected).

ALTER TABLE users ADD COLUMN is_platform_admin INTEGER NOT NULL DEFAULT 0;

ALTER TABLE livekit_instances ADD COLUMN max_servers INTEGER NOT NULL DEFAULT 0;
