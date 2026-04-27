-- 007_channel_reads.sql
-- Channel read state tracking — used for the unread message badge.
--
-- Stores the last-read message ID for each user-channel pair.
-- The unread count is then computed as the number of messages after that ID.
--
-- Why last_read_message_id?
-- Marking every individual message as read/unread would be very expensive.
-- A watermark ("I have read up to this point") is much more efficient.

CREATE TABLE IF NOT EXISTS channel_reads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_message_id TEXT,
    last_read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
);
