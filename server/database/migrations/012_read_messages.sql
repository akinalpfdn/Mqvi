-- 012_read_messages.sql
-- Adds the PermReadMessages (bit 2048) permission to the default role.
-- All users should be able to read messages by default.
-- ConnectVoice (64) and Speak (128) are also added to the default role.
UPDATE roles SET permissions = permissions | 2048 | 64 | 128 WHERE is_default = 1;
