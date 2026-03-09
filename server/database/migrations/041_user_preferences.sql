-- User preferences: server-side persistence for client settings (theme, sidebar, voice, etc.)
-- Single JSON blob per user — flexible, no migration needed for new keys.

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT NOT NULL DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
