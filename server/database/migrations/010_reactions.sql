-- 010_reactions.sql
-- Emoji reaction system.
-- A user can add the same emoji to a message only once (UNIQUE constraint).
-- When a message is deleted, related reactions are removed automatically (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
