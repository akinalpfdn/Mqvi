-- 016_dm_features.sql
-- DM mesajlarına reply, pin, reaction ve FTS5 arama desteği ekler.
-- Channel mesaj sistemindeki 010_reactions, 011_reply_to, 005_pinned_messages
-- ve 006_fts5_search migration'larının DM karşılıkları.

-- ─── Reply desteği ───
-- reply_to_id NULL → normal mesaj
-- reply_to_id dolu → yanıt mesajı (referans mesajın ID'si)
-- FK constraint YOK: Referans mesaj silindiğinde reply_to_id korunur (Discord davranışı)
ALTER TABLE dm_messages ADD COLUMN reply_to_id TEXT;
CREATE INDEX IF NOT EXISTS idx_dm_messages_reply_to ON dm_messages(reply_to_id);

-- ─── Pin desteği ───
ALTER TABLE dm_messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_dm_messages_pinned ON dm_messages(dm_channel_id, is_pinned) WHERE is_pinned = 1;

-- ─── DM Reactions tablosu ───
-- Channel reactions tablosu (010_reactions.sql) ile aynı yapı.
-- Bir kullanıcı bir DM mesajına aynı emojiyi sadece bir kez ekleyebilir.
CREATE TABLE IF NOT EXISTS dm_reactions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    dm_message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dm_message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_dm_reactions_message ON dm_reactions(dm_message_id);

-- ─── DM FTS5 tam metin arama ───
-- 006_fts5_search.sql ile aynı pattern: contentless FTS + trigger sync.
CREATE VIRTUAL TABLE IF NOT EXISTS dm_messages_fts USING fts5(
    content,
    content='dm_messages',
    content_rowid='rowid'
);

-- Mevcut DM mesajlarını FTS tablosuna aktar
INSERT OR IGNORE INTO dm_messages_fts(rowid, content)
    SELECT rowid, content FROM dm_messages WHERE content IS NOT NULL;

-- Yeni DM mesajı eklendiğinde FTS güncelle
CREATE TRIGGER IF NOT EXISTS dm_messages_ai AFTER INSERT ON dm_messages
WHEN NEW.content IS NOT NULL
BEGIN
    INSERT INTO dm_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- DM mesajı güncellendiğinde FTS güncelle
CREATE TRIGGER IF NOT EXISTS dm_messages_au AFTER UPDATE OF content ON dm_messages
BEGIN
    DELETE FROM dm_messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO dm_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- DM mesajı silindiğinde FTS'ten sil
CREATE TRIGGER IF NOT EXISTS dm_messages_ad AFTER DELETE ON dm_messages
BEGIN
    DELETE FROM dm_messages_fts WHERE rowid = OLD.rowid;
END;
