CREATE TABLE IF NOT EXISTS user_storage (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bytes_used INTEGER NOT NULL DEFAULT 0,
    quota_bytes INTEGER NOT NULL DEFAULT 10737418240,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
