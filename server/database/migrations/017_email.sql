-- 017_email.sql — Kullanıcılara opsiyonel email alanı ekler.
-- Email şifremi unuttum akışı için kullanılacak.
-- NULL olan email'ler unique constraint'i tetiklemez (partial index).

ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
