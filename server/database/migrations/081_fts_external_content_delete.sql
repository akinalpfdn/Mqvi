-- Fix the delete half of every external-content FTS5 trigger.
--
-- `DELETE FROM x_fts WHERE rowid = OLD.rowid` looks right but is not: an external-content
-- table reconstructs the terms to remove by reading the content table, and an AFTER trigger
-- runs once the content table already holds the NEW row. FTS5 therefore removes the wrong
-- terms. On servers_fts that surfaces as SQLITE_CORRUPT_VTAB (editing a server description
-- returned a 500); on messages_fts and dm_messages_fts it fails silently and the old text
-- stays searchable forever.
--
-- The documented form passes the OLD values explicitly. Rows the insert trigger skipped
-- (attachment-only messages with NULL content, and encrypted messages) were never indexed,
-- so the delete must skip them too or FTS5 raises corruption on a term it never stored.

DROP TRIGGER IF EXISTS messages_au;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS dm_messages_au;
DROP TRIGGER IF EXISTS dm_messages_ad;
DROP TRIGGER IF EXISTS servers_au;
DROP TRIGGER IF EXISTS servers_ad;

CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages
WHEN OLD.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    SELECT 'delete', OLD.rowid, OLD.content WHERE OLD.content IS NOT NULL;

    INSERT INTO messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages
WHEN OLD.content IS NOT NULL AND OLD.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER dm_messages_au AFTER UPDATE OF content ON dm_messages
WHEN OLD.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(dm_messages_fts, rowid, content)
    SELECT 'delete', OLD.rowid, OLD.content WHERE OLD.content IS NOT NULL;

    INSERT INTO dm_messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

CREATE TRIGGER dm_messages_ad AFTER DELETE ON dm_messages
WHEN OLD.content IS NOT NULL AND OLD.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(dm_messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER servers_au AFTER UPDATE OF name, description ON servers
BEGIN
    INSERT INTO servers_fts(servers_fts, rowid, name, description)
    VALUES ('delete', OLD.rowid, OLD.name, COALESCE(OLD.description, ''));

    INSERT INTO servers_fts(rowid, name, description)
    VALUES (NEW.rowid, NEW.name, COALESCE(NEW.description, ''));
END;

CREATE TRIGGER servers_ad AFTER DELETE ON servers
BEGIN
    INSERT INTO servers_fts(servers_fts, rowid, name, description)
    VALUES ('delete', OLD.rowid, OLD.name, COALESCE(OLD.description, ''));
END;

-- Purge the terms the broken triggers left behind. A plain 'rebuild' would re-index every
-- content row, including the encrypted and attachment-only ones the insert triggers skip,
-- so reinsert with the same predicate instead.
INSERT INTO messages_fts(messages_fts) VALUES ('delete-all');
INSERT INTO messages_fts(rowid, content)
    SELECT rowid, content FROM messages WHERE content IS NOT NULL AND encryption_version = 0;

INSERT INTO dm_messages_fts(dm_messages_fts) VALUES ('delete-all');
INSERT INTO dm_messages_fts(rowid, content)
    SELECT rowid, content FROM dm_messages WHERE content IS NOT NULL AND encryption_version = 0;

INSERT INTO servers_fts(servers_fts) VALUES ('delete-all');
INSERT INTO servers_fts(rowid, name, description)
    SELECT rowid, name, COALESCE(description, '') FROM servers;
