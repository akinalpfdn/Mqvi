-- 034: E2EE message field changes + FTS5 trigger updates.
--
-- E2EE fields are added to the existing messages and dm_messages tables:
-- - encryption_version: 0=plaintext (legacy), 1=E2EE
-- - ciphertext: Base64-encrypted content (server CANNOT read this)
-- - sender_device_id: ID of the device that sent the message
-- - e2ee_metadata: JSON — protocol metadata such as session_id, message_index, etc.
--
-- FTS5 triggers are updated: only encryption_version=0 (plaintext) messages
-- are indexed. Because E2EE messages have NULL content FTS5 cannot index them
-- anyway, but the trigger condition is added to make this explicit.
--
-- device_id is added to the sessions table — a login session is bound to a device.

-- ─── messages table ───
ALTER TABLE messages ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN ciphertext TEXT;
ALTER TABLE messages ADD COLUMN sender_device_id TEXT;
ALTER TABLE messages ADD COLUMN e2ee_metadata TEXT;

-- ─── dm_messages table ───
ALTER TABLE dm_messages ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dm_messages ADD COLUMN ciphertext TEXT;
ALTER TABLE dm_messages ADD COLUMN sender_device_id TEXT;
ALTER TABLE dm_messages ADD COLUMN e2ee_metadata TEXT;

-- ─── FTS5 trigger updates ───
-- Drop the existing triggers and create E2EE-aware versions.
-- Index when encryption_version=0 (plaintext); otherwise skip indexing.

DROP TRIGGER IF EXISTS messages_ai;
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
WHEN NEW.content IS NOT NULL AND NEW.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

DROP TRIGGER IF EXISTS messages_au;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages
WHEN OLD.encryption_version = 0
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

DROP TRIGGER IF EXISTS dm_messages_ai;
CREATE TRIGGER IF NOT EXISTS dm_messages_ai AFTER INSERT ON dm_messages
WHEN NEW.content IS NOT NULL AND NEW.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

DROP TRIGGER IF EXISTS dm_messages_au;
CREATE TRIGGER IF NOT EXISTS dm_messages_au AFTER UPDATE OF content ON dm_messages
WHEN OLD.encryption_version = 0
BEGIN
    DELETE FROM dm_messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO dm_messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

-- ─── device_id link added to sessions table ───
ALTER TABLE sessions ADD COLUMN device_id TEXT;
