-- 098: One sessions row per signed-in device ("family"), refresh token stored only as a hash.
-- Rotation keeps the previous hash so a lost response or a parallel refresh is not a logout;
-- pending_token holds the encrypted latest token so parallel refreshes in the grace window get the
-- same answer. Pre-098 plaintext tokens move to legacy_token and are retired on first rotation.
-- Rebuilt rather than altered: refresh_token is NOT NULL UNIQUE and cannot be relaxed in place.

CREATE TABLE IF NOT EXISTS sessions_new (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT UNIQUE,
    prev_token_hash TEXT,
    pending_token   TEXT,
    legacy_token    TEXT UNIQUE,
    device_id       TEXT,
    rotated_at      DATETIME,
    expires_at      DATETIME NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK (token_hash IS NOT NULL OR legacy_token IS NOT NULL)
);

INSERT INTO sessions_new (id, user_id, legacy_token, device_id, expires_at, created_at)
SELECT id, user_id, refresh_token, device_id, expires_at, created_at FROM sessions;

DROP TABLE sessions;

ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_prev_token ON sessions(prev_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
