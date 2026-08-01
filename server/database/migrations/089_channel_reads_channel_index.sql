-- 089_channel_reads_channel_index.sql
-- Index the unread fan-out.
--
-- channel_reads has PRIMARY KEY (user_id, channel_id), which SQLite can only use when the
-- leading column is known. IncrementUnreadCounts does the opposite:
--
--   UPDATE channel_reads SET unread_count = unread_count + 1
--   WHERE channel_id = ? AND user_id != ?
--
-- so it scanned the whole table — once per message sent, on every channel in the deployment.
-- DecrementUnreadForDeleted has the same leading predicate and benefits identically.

CREATE INDEX IF NOT EXISTS idx_channel_reads_channel ON channel_reads(channel_id);
