-- How far each participant's app has received a DM conversation — the double tick.
--
-- A watermark per (user, conversation), the same shape as dm_reads: (created_at, rowid) is a total
-- order over a conversation's messages (created_at is whole seconds, rowid breaks the tie), and a
-- receiver that has a message has every one before it. One row per participant instead of one
-- per message keeps a report a single upsert however much arrived while the app was closed.
--
-- Kept apart from dm_reads on purpose: a tick derived from reads would tell the sender when their
-- message was read. An app too old to report delivery leaves its sender on a single tick.
CREATE TABLE IF NOT EXISTS dm_deliveries (
    user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dm_channel_id             TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    last_delivered_message_id TEXT,
    last_delivered_at         DATETIME NOT NULL,
    last_delivered_seq        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, dm_channel_id)
);

-- Baseline: everything that already exists was delivered. Without it every message sent before
-- this deploy would sit on a single tick until its receiver happened to open that conversation.
-- DO NOTHING: a row already here is a real position and must not be moved.
INSERT INTO dm_deliveries (user_id, dm_channel_id, last_delivered_message_id, last_delivered_at, last_delivered_seq)
SELECT p.user_id, p.dm_channel_id, newest.id, newest.created_at, newest.rowid
FROM (
    SELECT user1_id AS user_id, id AS dm_channel_id FROM dm_channels
    UNION
    SELECT user2_id AS user_id, id AS dm_channel_id FROM dm_channels
) p
JOIN dm_messages newest ON newest.rowid = (
    SELECT rowid FROM dm_messages
    WHERE dm_channel_id = p.dm_channel_id
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
)
ON CONFLICT(user_id, dm_channel_id) DO NOTHING;
