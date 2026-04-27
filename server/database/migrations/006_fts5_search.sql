-- 006_fts5_search.sql
-- SQLite FTS5 (Full-Text Search 5) full-text search system.
--
-- What is FTS5?
-- SQLite's built-in full-text search engine. It is much faster than a
-- regular LIKE '%keyword%' query — especially on large data sets.
-- It tokenizes content, builds an index and performs ranking (BM25).
--
-- We create a "contentless" FTS table via content=.
-- This means the FTS table does not duplicate the message content.
-- Triggers keep the FTS table in sync when the messages table changes.
--
-- modernc.org/sqlite supports FTS5 by default.

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
);

-- Backfill existing messages into the FTS table
INSERT OR IGNORE INTO messages_fts(rowid, content)
    SELECT rowid, content FROM messages WHERE content IS NOT NULL;

-- Update FTS table when a new message is inserted
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
WHEN NEW.content IS NOT NULL
BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Update FTS table when a message is updated
-- Delete the old row first, then insert the new one
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Remove from FTS when a message is deleted
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
END;
