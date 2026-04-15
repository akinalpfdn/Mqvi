-- 057: Switch FTS5 tokenizer from unicode61 (word-based) to trigram.
--
-- Problem: the default tokenizer indexes whole words. A search for "bbbcc"
-- against the message "aaaaabbcc" would not match because "bbbcc" is not a
-- prefix of the token. Users expect Discord/Slack-style substring search.
--
-- Trigram indexes every 3-character sequence of the content, which makes
-- arbitrary substring queries match naturally (and remains case-insensitive).
--
-- Triggers must be dropped first — they reference the FTS tables. We recreate
-- them with identical logic (same names, same encryption_version=0 guard).

-- ─── Drop existing triggers ───
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_au;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS dm_messages_ai;
DROP TRIGGER IF EXISTS dm_messages_au;
DROP TRIGGER IF EXISTS dm_messages_ad;

-- ─── Rebuild channel messages FTS with trigram tokenizer ───
DROP TABLE IF EXISTS messages_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram'
);

-- Re-index existing plaintext messages (E2EE messages have content=NULL)
INSERT OR IGNORE INTO messages_fts(rowid, content)
    SELECT rowid, content FROM messages
    WHERE content IS NOT NULL AND encryption_version = 0;

-- ─── Rebuild DM messages FTS with trigram tokenizer ───
DROP TABLE IF EXISTS dm_messages_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS dm_messages_fts USING fts5(
    content,
    content='dm_messages',
    content_rowid='rowid',
    tokenize='trigram'
);

INSERT OR IGNORE INTO dm_messages_fts(rowid, content)
    SELECT rowid, content FROM dm_messages
    WHERE content IS NOT NULL AND encryption_version = 0;

-- ─── Recreate triggers (same logic as migration 034) ───

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
WHEN NEW.content IS NOT NULL AND NEW.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages
WHEN OLD.encryption_version = 0
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS dm_messages_ai AFTER INSERT ON dm_messages
WHEN NEW.content IS NOT NULL AND NEW.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS dm_messages_au AFTER UPDATE OF content ON dm_messages
WHEN OLD.encryption_version = 0
BEGIN
    DELETE FROM dm_messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO dm_messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

CREATE TRIGGER IF NOT EXISTS dm_messages_ad AFTER DELETE ON dm_messages
BEGIN
    DELETE FROM dm_messages_fts WHERE rowid = OLD.rowid;
END;
