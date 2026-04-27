-- 008_mentions.sql
-- Message mention tracking.
--
-- Users mentioned in a message via @username are stored in this table.
-- This allows us to:
-- 1. Query messages where a user was mentioned
-- 2. Add a mention count to the unread badge
-- 3. Send mention notifications

CREATE TABLE IF NOT EXISTS message_mentions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON message_mentions(user_id);
CREATE INDEX IF NOT EXISTS idx_mentions_message ON message_mentions(message_id);
