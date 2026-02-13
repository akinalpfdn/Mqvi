-- 006_fts5_search.sql
-- SQLite FTS5 (Full-Text Search 5) tam metin arama sistemi.
--
-- FTS5 nedir?
-- SQLite'ın yerleşik tam metin arama motoru. Normal LIKE '%keyword%'
-- sorgusundan çok daha hızlıdır — özellikle büyük veri setlerinde.
-- Tokenize eder, index oluşturur ve ranking (BM25) yapar.
--
-- content= ile "contentless" FTS tablo oluşturuyoruz.
-- Bu, FTS tablosunun mesaj içeriğini duplike etmemesi anlamına gelir.
-- Trigger'lar ile messages tablosu değiştiğinde FTS otomatik güncellenir.
--
-- modernc.org/sqlite FTS5'i varsayılan olarak destekler.

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
);

-- Mevcut mesajları FTS tablosuna aktar
INSERT OR IGNORE INTO messages_fts(rowid, content)
    SELECT rowid, content FROM messages WHERE content IS NOT NULL;

-- Yeni mesaj eklendiğinde FTS tablosunu güncelle
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
WHEN NEW.content IS NOT NULL
BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Mesaj güncellendiğinde FTS tablosunu güncelle
-- Önce eski kaydı sil, sonra yenisini ekle
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Mesaj silindiğinde FTS'ten de sil
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
END;
