-- 009_dm.sql
-- Direct Messages (DM) — private messaging between users.
--
-- DM channels are independent of server channels.
-- A unique DM channel is created for each pair of users.
-- The user1_id < user2_id ordering is enforced at the service layer.

-- DM channels
CREATE TABLE IF NOT EXISTS dm_channels (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user1_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1_id, user2_id)
);

-- DM messages
CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    edited_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel ON dm_messages(dm_channel_id, created_at DESC);

-- DM attachments
CREATE TABLE IF NOT EXISTS dm_attachments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    dm_message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_attachments_message ON dm_attachments(dm_message_id);
