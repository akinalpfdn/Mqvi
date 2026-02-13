-- 005_pinned_messages.sql
-- Mesaj sabitleme (pin) sistemi için tablo.
--
-- Bir mesaj sadece bir kez pinlenebilir (UNIQUE constraint).
-- Pin kaldırıldığında satır silinir (soft delete yok).
-- Mesaj veya kanal silindiğinde CASCADE ile pin de silinir.

CREATE TABLE IF NOT EXISTS pinned_messages (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    pinned_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id)
);

CREATE INDEX IF NOT EXISTS idx_pinned_channel ON pinned_messages(channel_id, created_at DESC);
