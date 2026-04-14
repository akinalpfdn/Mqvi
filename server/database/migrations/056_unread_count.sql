-- 056: Denormalize unread count per (user, channel) to eliminate the nested
-- COUNT(*) subquery that runs on every server-view load.
--
-- The count is maintained by application code:
--   - Incremented in message_service.Create after a successful INSERT.
--   - Reset to 0 in ReadState.Upsert and MarkAllRead (mark-as-read paths).
--
-- GetUnreadCounts reads the column directly for channels with a channel_reads
-- row, and falls back to a COUNT(*) subquery only for channels the user has
-- never opened (no row exists yet).

ALTER TABLE channel_reads ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0;

-- One-time backfill: compute the current unread count for every existing row
-- using the same watermark logic the old query applied. Safe to run again
-- because the column default is 0 and this replaces it with the correct value.
UPDATE channel_reads
SET unread_count = (
    SELECT COUNT(*)
    FROM messages m
    WHERE m.channel_id = channel_reads.channel_id
      AND m.user_id != channel_reads.user_id
      AND (
          channel_reads.last_read_message_id IS NULL
          OR m.created_at > (
              SELECT created_at FROM messages WHERE id = channel_reads.last_read_message_id
          )
      )
);
