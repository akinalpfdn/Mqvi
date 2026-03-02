-- 026: dm_channels tablosuna last_message_at sütunu ekle.
--
-- DM kanallarını son mesaj aktivitesine göre sıralamak için kullanılır.
-- NULL = henüz mesaj yok (created_at'e fallback edilir).
-- SQLite trigger ile otomatik güncellenir.

-- 1. Yeni sütun
ALTER TABLE dm_channels ADD COLUMN last_message_at DATETIME;

-- 2. Mevcut verileri backfill — her kanalın son mesajının created_at'ini ata
UPDATE dm_channels
SET last_message_at = (
    SELECT MAX(dm_messages.created_at)
    FROM dm_messages
    WHERE dm_messages.dm_channel_id = dm_channels.id
);

-- 3. Yeni DM mesajı eklendiğinde last_message_at güncelle
CREATE TRIGGER IF NOT EXISTS dm_channels_update_last_message_ai
AFTER INSERT ON dm_messages
BEGIN
    UPDATE dm_channels
    SET last_message_at = NEW.created_at
    WHERE id = NEW.dm_channel_id;
END;

-- 4. DM mesajı silindiğinde last_message_at'i yeniden hesapla
CREATE TRIGGER IF NOT EXISTS dm_channels_update_last_message_ad
AFTER DELETE ON dm_messages
BEGIN
    UPDATE dm_channels
    SET last_message_at = (
        SELECT MAX(created_at)
        FROM dm_messages
        WHERE dm_channel_id = OLD.dm_channel_id
    )
    WHERE id = OLD.dm_channel_id;
END;
