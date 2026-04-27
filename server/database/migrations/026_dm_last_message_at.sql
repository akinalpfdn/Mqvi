-- 026: Add a last_message_at column to dm_channels.
--
-- Used to sort DM channels by last message activity.
-- NULL = no messages yet (fallback to created_at).
-- Kept up to date automatically via SQLite triggers.

-- 1. New column
ALTER TABLE dm_channels ADD COLUMN last_message_at DATETIME;

-- 2. Backfill existing data — set each channel's last message created_at
UPDATE dm_channels
SET last_message_at = (
    SELECT MAX(dm_messages.created_at)
    FROM dm_messages
    WHERE dm_messages.dm_channel_id = dm_channels.id
);

-- 3. Update last_message_at when a new DM message is inserted
CREATE TRIGGER IF NOT EXISTS dm_channels_update_last_message_ai
AFTER INSERT ON dm_messages
BEGIN
    UPDATE dm_channels
    SET last_message_at = NEW.created_at
    WHERE id = NEW.dm_channel_id;
END;

-- 4. Recompute last_message_at when a DM message is deleted
CREATE TRIGGER IF NOT EXISTS dm_channels_update_last_message_ad
AFTER DELETE ON dm_messages
BEGIN
    UPDATE dm_channels
    SET last_message_at = (
        SELECT MAX(created_at)
        FROM dm_messages
        WHERE dm_channel_id = OLD.dm_channel_id
    )
    WHERE id = OLD.dm_channel_id;
END;
