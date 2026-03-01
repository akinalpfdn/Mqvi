-- 020_platform_admin.sql
-- Platform admin + çoklu LiveKit instance kapasite desteği.
--
-- is_platform_admin: Platform yöneticisi bayrağı.
-- SQL ile manual atanır: UPDATE users SET is_platform_admin = 1 WHERE id = '...';
--
-- max_servers: LiveKit instance başına maksimum sunucu kapasitesi.
-- 0 = sınırsız (mevcut instance'lar etkilenmez).

ALTER TABLE users ADD COLUMN is_platform_admin INTEGER NOT NULL DEFAULT 0;

ALTER TABLE livekit_instances ADD COLUMN max_servers INTEGER NOT NULL DEFAULT 0;
