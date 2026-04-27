-- 017_email.sql — Adds an optional email field to users.
-- Used for the forgot-password flow.
-- NULL emails do not trigger the unique constraint (partial index).

ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
