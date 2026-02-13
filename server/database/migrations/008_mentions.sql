-- 008_mentions.sql
-- Mesaj mention (bahsetme) takibi.
--
-- Bir mesajda @username ile bahsedilen kullanıcılar bu tabloda tutulur.
-- Bu sayede:
-- 1. Bir kullanıcının mention aldığı mesajlar sorgulanabilir
-- 2. Unread badge'e mention sayısı eklenebilir
-- 3. Mention bildirimleri gönderilebilir

CREATE TABLE IF NOT EXISTS message_mentions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON message_mentions(user_id);
CREATE INDEX IF NOT EXISTS idx_mentions_message ON message_mentions(message_id);
