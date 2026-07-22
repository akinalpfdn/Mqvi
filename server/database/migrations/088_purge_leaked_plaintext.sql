-- Remove plaintext left behind on encrypted messages by the old edit path.
--
-- Until this release an edit ran `UPDATE ... SET content = ?` unconditionally, and a client could
-- take the plaintext edit path on an encrypted conversation (it read the ACTIVE server's E2EE flag
-- rather than the target's). The result is a row that says encryption_version = 1, still holds its
-- original ciphertext, and carries the edited text in `content` — readable by anyone with database
-- access, for a message the user believes is end-to-end encrypted.
--
-- Fixing the write path only stops new ones. These rows sit there until someone edits the message
-- again, which may be never, so they are cleared here.
--
-- `encryption_version = 1 AND content IS NOT NULL` is exclusively that bug's fingerprint: message
-- creation only ever writes `content` for version 0, so no legitimate row has both.
--
-- What is lost is the text of that one edit. It is already invisible — the client renders the
-- ciphertext, which still holds the pre-edit message — so nothing a user can see changes, and the
-- alternative is leaving readable plaintext on disk.
--
-- FTS is untouched by design: the insert trigger only ever indexed version 0, and 081's rebuild
-- filtered on the same condition, so these rows were never in the index. The update trigger from
-- 087 fires on `OLD.encryption_version = 0 OR NEW.encryption_version = 0`, and both sides are 1
-- here, so it stays a no-op.

UPDATE messages
SET content = NULL
WHERE encryption_version = 1 AND content IS NOT NULL;

UPDATE dm_messages
SET content = NULL
WHERE encryption_version = 1 AND content IS NOT NULL;
