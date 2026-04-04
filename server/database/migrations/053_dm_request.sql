-- DM Request system: non-friends can send 1 message as a request.
-- Recipient must accept before sender can send more.
-- 'accepted' = normal DM (friends or accepted request)
-- 'pending'  = request from non-friend, awaiting recipient response
ALTER TABLE dm_channels ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted';
ALTER TABLE dm_channels ADD COLUMN initiated_by TEXT;
