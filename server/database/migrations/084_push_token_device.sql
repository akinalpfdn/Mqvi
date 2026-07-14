-- Link a push token to the installation that owns it.
--
-- Without this the server can only address a USER, never one of their devices — so when a call
-- is answered and the rest have to stop ringing, the cancel push goes to every device including
-- the one that just answered. Each platform then needs a local hack to work out "was that meant
-- for me?", and the iOS one breaks Apple's PushKit contract (a VoIP push that reports no call
-- to CallKit gets the app terminated and its VoIP delivery revoked).
--
-- Nullable: old clients register without it, and the server falls back to addressing the whole
-- user, which is exactly today's behaviour.
ALTER TABLE push_tokens ADD COLUMN device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(user_id, device_id);
