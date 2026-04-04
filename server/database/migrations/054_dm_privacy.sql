-- Per-user DM privacy setting.
-- 'everyone' = anyone can DM freely
-- 'message_request' = non-friends send 1 msg as request (default)
-- 'friends_only' = only accepted friends can DM
ALTER TABLE users ADD COLUMN dm_privacy TEXT NOT NULL DEFAULT 'message_request';
