-- App logs: structured logging for user-impacting errors (voice, video, screen share, WS).
CREATE TABLE IF NOT EXISTS app_logs (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    level       TEXT NOT NULL DEFAULT 'error',   -- error, warn, info
    category    TEXT NOT NULL DEFAULT 'general',  -- voice, video, screen_share, ws, auth, general
    user_id     TEXT,                              -- nullable: system-level events have no user
    server_id   TEXT,                              -- nullable: context server
    message     TEXT NOT NULL,
    metadata    TEXT DEFAULT '{}',                 -- JSON blob for structured context
    created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_logs_created_at ON app_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_app_logs_category ON app_logs(category);
CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);
CREATE INDEX IF NOT EXISTS idx_app_logs_user_id ON app_logs(user_id);
