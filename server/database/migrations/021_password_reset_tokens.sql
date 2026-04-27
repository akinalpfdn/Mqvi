-- 021: Password Reset Tokens table.
--
-- Password reset flow:
-- 1. User submits email → backend generates a token
-- 2. SHA256 hash of the token is stored in this table (security: never store plaintext)
-- 3. Plaintext token is sent via email
-- 4. User submits the token → backend hashes it and compares
-- 5. If it matches and is not expired → password is updated, token is deleted
--
-- user_id CASCADE: When the user is deleted, their tokens are deleted too.
-- token_hash UNIQUE: The same hash cannot be stored twice (collision protection).
-- expires_at: Token validity duration (20 minutes).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
