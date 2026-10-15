-- Voice-chat messages are reportable, and the server records where the excerpt
-- came from: 'server' = copied from stored plaintext at report time,
-- 'client' = supplied by the reporter (E2EE content the server cannot read).
ALTER TABLE reports ADD COLUMN voice_message_id TEXT;
ALTER TABLE reports ADD COLUMN excerpt_source TEXT;
