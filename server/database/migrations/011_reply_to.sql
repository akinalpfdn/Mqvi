-- 011_reply_to.sql
-- Reply system: a message can be sent as a reply to another message.
--
-- reply_to_id NULL → regular message
-- reply_to_id set → reply message (ID of the referenced message)
--
-- FK constraint is NOT used: reply_to_id is preserved when the referenced message is deleted.
-- The referenced message is fetched via LEFT JOIN:
--   - reply_to_id NOT NULL, JOIN result present → show the full reference
--   - reply_to_id NOT NULL, JOIN result NULL → show "Original message was deleted"
--   - reply_to_id NULL → not a reply, no reference shown
--
-- This mirrors Discord's behavior: replies to deleted messages display
-- "Original message was deleted".

ALTER TABLE messages ADD COLUMN reply_to_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id);
