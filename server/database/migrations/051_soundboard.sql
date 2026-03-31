CREATE TABLE IF NOT EXISTS soundboard_sounds (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    emoji TEXT,
    file_url TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_soundboard_sounds_server ON soundboard_sounds(server_id);
