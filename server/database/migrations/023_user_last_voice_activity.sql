-- Migration 023: Kullanıcı bazında son ses aktivitesi takibi.
-- Platform admin panelde kullanıcının last_activity'sinde
-- hem mesaj hem ses kanalı katılımı gösterilir.
ALTER TABLE users ADD COLUMN last_voice_activity TEXT;
