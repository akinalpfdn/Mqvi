-- 009_dm.sql
-- Direct Messages (DM) — kullanıcılar arası özel mesajlaşma.
--
-- DM kanalları server kanallarından bağımsızdır.
-- Her kullanıcı çifti için benzersiz bir DM kanalı oluşturulur.
-- user1_id < user2_id sıralaması service katmanında sağlanır.

-- DM kanalları
CREATE TABLE IF NOT EXISTS dm_channels (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user1_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1_id, user2_id)
);

-- DM mesajları
CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    edited_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel ON dm_messages(dm_channel_id, created_at DESC);

-- DM ekleri
CREATE TABLE IF NOT EXISTS dm_attachments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    dm_message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_attachments_message ON dm_attachments(dm_message_id);
