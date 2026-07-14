-- Per-user read watermark for DM channels.
--
-- Until now DM unread state lived only in the client's memory, so a phone and a desktop
-- kept entirely independent badges and nothing could tell one device that the other had
-- read the conversation. Kept separate from user_dm_settings (mute/pin/hide) for the same
-- reason channel_reads is separate from channel settings: that table is preference, this
-- one is position.
--
-- last_read_at is the referenced MESSAGE's created_at, not the clock — the unread count is
-- derived from it, so it has to be comparable against dm_messages.created_at.
CREATE TABLE IF NOT EXISTS dm_reads (
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dm_channel_id        TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    last_read_message_id TEXT,
    last_read_at         DATETIME NOT NULL,
    PRIMARY KEY (user_id, dm_channel_id)
);
