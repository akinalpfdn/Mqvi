-- Full-text search over server name + description for the public discovery directory.
-- Trigram tokenizer for Discord-style substring search (and works for non-Latin scripts).
-- External-content FTS mirroring the messages_fts pattern (migration 057).

CREATE VIRTUAL TABLE IF NOT EXISTS servers_fts USING fts5(
    name,
    description,
    content='servers',
    content_rowid='rowid',
    tokenize='trigram'
);

-- Backfill existing servers.
INSERT OR IGNORE INTO servers_fts(rowid, name, description)
    SELECT rowid, name, COALESCE(description, '') FROM servers;

CREATE TRIGGER IF NOT EXISTS servers_ai AFTER INSERT ON servers
BEGIN
    INSERT INTO servers_fts(rowid, name, description) VALUES (NEW.rowid, NEW.name, COALESCE(NEW.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS servers_au AFTER UPDATE OF name, description ON servers
BEGIN
    DELETE FROM servers_fts WHERE rowid = OLD.rowid;
    INSERT INTO servers_fts(rowid, name, description) VALUES (NEW.rowid, NEW.name, COALESCE(NEW.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS servers_ad AFTER DELETE ON servers
BEGIN
    DELETE FROM servers_fts WHERE rowid = OLD.rowid;
END;
