-- 016_dm_features.sql
-- Adds reply, pin, reaction and FTS5 search support to DM messages.
-- DM counterparts of the channel-message migrations 010_reactions, 011_reply_to,
-- 005_pinned_messages and 006_fts5_search.

-- ─── Reply support ───
-- reply_to_id NULL → regular message
-- reply_to_id set → reply message (ID of the referenced message)
-- No FK constraint: reply_to_id is preserved when the referenced message is deleted (Discord behavior)
ALTER TABLE dm_messages ADD COLUMN reply_to_id TEXT;
CREATE INDEX IF NOT EXISTS idx_dm_messages_reply_to ON dm_messages(reply_to_id);

-- ─── Pin support ───
ALTER TABLE dm_messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_dm_messages_pinned ON dm_messages(dm_channel_id, is_pinned) WHERE is_pinned = 1;

-- ─── DM Reactions table ───
-- Same structure as the channel reactions table (010_reactions.sql).
-- A user can add the same emoji to a DM message only once.
CREATE TABLE IF NOT EXISTS dm_reactions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    dm_message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dm_message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_dm_reactions_message ON dm_reactions(dm_message_id);

-- ─── DM FTS5 full-text search ───
-- Same pattern as 006_fts5_search.sql: contentless FTS + trigger sync.
CREATE VIRTUAL TABLE IF NOT EXISTS dm_messages_fts USING fts5(
    content,
    content='dm_messages',
    content_rowid='rowid'
);

-- Backfill existing DM messages into the FTS table
INSERT OR IGNORE INTO dm_messages_fts(rowid, content)
    SELECT rowid, content FROM dm_messages WHERE content IS NOT NULL;

-- Update FTS when a new DM message is inserted
CREATE TRIGGER IF NOT EXISTS dm_messages_ai AFTER INSERT ON dm_messages
WHEN NEW.content IS NOT NULL
BEGIN
    INSERT INTO dm_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Update FTS when a DM message is updated
CREATE TRIGGER IF NOT EXISTS dm_messages_au AFTER UPDATE OF content ON dm_messages
BEGIN
    DELETE FROM dm_messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO dm_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Remove from FTS when a DM message is deleted
CREATE TRIGGER IF NOT EXISTS dm_messages_ad AFTER DELETE ON dm_messages
BEGIN
    DELETE FROM dm_messages_fts WHERE rowid = OLD.rowid;
END;
