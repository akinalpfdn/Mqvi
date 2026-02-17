-- 012_read_messages.sql
-- PermReadMessages (bit 2048) yetkisini default role'e ekler.
-- Tüm kullanıcılar varsayılan olarak mesajları okuyabilmeli.
-- Ayrıca ConnectVoice (64) ve Speak (128) de default role'e eklenir.
UPDATE roles SET permissions = permissions | 2048 | 64 | 128 WHERE is_default = 1;
