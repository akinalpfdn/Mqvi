-- 034: E2EE mesaj alani degisiklikleri + FTS5 trigger guncellemeleri.
--
-- Mevcut messages ve dm_messages tablolarina E2EE alanlari eklenir:
-- - encryption_version: 0=plaintext (legacy), 1=E2EE
-- - ciphertext: Base64 sifrelenmis icerik (sunucu bunu OKUYAMAZ)
-- - sender_device_id: Mesaji gonderen cihazin ID'si
-- - e2ee_metadata: JSON — session_id, message_index vb. protokol meta verisi
--
-- FTS5 trigger'lari guncellenir: Sadece encryption_version=0 (plaintext) mesajlar
-- indexlenir. E2EE mesajlarin content'i NULL olacagindan FTS5 bunlari zaten
-- indexleyemez, ama trigger kosulu eklenerek explicit hale getirilir.
--
-- sessions tablosuna device_id eklenir — login session'i cihaza baglanir.

-- ─── messages tablosu ───
ALTER TABLE messages ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN ciphertext TEXT;
ALTER TABLE messages ADD COLUMN sender_device_id TEXT;
ALTER TABLE messages ADD COLUMN e2ee_metadata TEXT;

-- ─── dm_messages tablosu ───
ALTER TABLE dm_messages ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dm_messages ADD COLUMN ciphertext TEXT;
ALTER TABLE dm_messages ADD COLUMN sender_device_id TEXT;
ALTER TABLE dm_messages ADD COLUMN e2ee_metadata TEXT;

-- ─── FTS5 trigger guncellemeleri ───
-- Mevcut trigger'lari kaldir ve E2EE-aware versiyonlarini olustur.
-- encryption_version=0 (plaintext) ise indexle, degilse indexleme.

DROP TRIGGER IF EXISTS messages_ai;
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
WHEN NEW.content IS NOT NULL AND NEW.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

DROP TRIGGER IF EXISTS messages_au;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages
WHEN OLD.encryption_version = 0
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

DROP TRIGGER IF EXISTS dm_messages_ai;
CREATE TRIGGER IF NOT EXISTS dm_messages_ai AFTER INSERT ON dm_messages
WHEN NEW.content IS NOT NULL AND NEW.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

DROP TRIGGER IF EXISTS dm_messages_au;
CREATE TRIGGER IF NOT EXISTS dm_messages_au AFTER UPDATE OF content ON dm_messages
WHEN OLD.encryption_version = 0
BEGIN
    DELETE FROM dm_messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO dm_messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

-- ─── sessions tablosuna device_id baglantisi ───
ALTER TABLE sessions ADD COLUMN device_id TEXT;
