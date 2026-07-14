-- Give the DM read watermark a tie-break, and treat existing history as read.
--
-- 082 keyed the watermark on created_at alone. That column is CURRENT_TIMESTAMP — WHOLE
-- SECONDS — so two messages sent in the same second are identical on it, and a strict `>`
-- swallowed all but the first: it never counted as unread, no badge appeared, and because the
-- count read 0 the server RETRACTED its push notification. dm_messages.id is random hex and
-- cannot order anything; rowid is assigned in insert order, so (last_read_at, last_read_seq)
-- is a total order that matches the order messages are shown in.
--
-- Split from 082 rather than folded into it: migrations are tracked by filename, so editing
-- one that has already been applied anywhere means the edit silently never runs.
ALTER TABLE dm_reads ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0;

-- Repair rows 082 already wrote: resolve each one's sequence from ITS OWN watermark message.
-- Must not touch where the user had read up to — only fill in the missing tie-break.
UPDATE dm_reads
SET last_read_seq = COALESCE(
        (SELECT m.rowid FROM dm_messages m WHERE m.id = dm_reads.last_read_message_id), 0)
WHERE last_read_seq = 0;

-- Baseline: everything that already exists is read.
--
-- A missing watermark means "has read nothing", so without this every conversation would
-- report its ENTIRE history as unread on the first load after deploy — a long DM would show a
-- badge in the hundreds, and the sidebar query would scan every message instead of seeking to
-- the unread tail. Unread was client-local and ephemeral until now, so there is nothing to
-- preserve; marking history read is the only truthful starting point.
--
-- DO NOTHING, never DO UPDATE: a user who already has a watermark has a real read position,
-- and fast-forwarding it to the newest message would silently mark their unread messages read.
INSERT INTO dm_reads (user_id, dm_channel_id, last_read_message_id, last_read_at, last_read_seq)
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
