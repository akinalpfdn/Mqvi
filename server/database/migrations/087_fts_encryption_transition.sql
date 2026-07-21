-- FTS triggers that survive an encryption_version change.
--
-- 034 wrote `WHEN OLD.encryption_version = 0` because the column never changed after insert. An
-- edit can now move a row between plaintext and encrypted — a conversation's E2EE setting can be
-- toggled between a message being written and being edited — and in the encrypted -> plaintext
-- direction OLD is 1, so the trigger never fired at all: the row ended up with readable content and
-- no FTS entry, invisible to server-side search for good. Client-side search does not cover it
-- either, since that only runs while a conversation still has E2EE on.
--
-- Firing on either side of the transition keeps the index in step both ways. The delete half keeps
-- the external-content form from 081 (a plain DELETE FROM removes the wrong terms) and now carries
-- the insert trigger's exact predicate, so it only ever removes rows that were actually indexed —
-- an encrypted row never was, and asking FTS5 to delete a term it never stored raises corruption.

DROP TRIGGER IF EXISTS messages_au;
CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages
WHEN OLD.encryption_version = 0 OR NEW.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    SELECT 'delete', OLD.rowid, OLD.content
    WHERE OLD.content IS NOT NULL AND OLD.encryption_version = 0;

    INSERT INTO messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content
    WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

DROP TRIGGER IF EXISTS dm_messages_au;
CREATE TRIGGER dm_messages_au AFTER UPDATE OF content ON dm_messages
WHEN OLD.encryption_version = 0 OR NEW.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(dm_messages_fts, rowid, content)
    SELECT 'delete', OLD.rowid, OLD.content
    WHERE OLD.content IS NOT NULL AND OLD.encryption_version = 0;

    INSERT INTO dm_messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content
    WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;
