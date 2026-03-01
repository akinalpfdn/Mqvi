-- 022: servers tablosuna last_voice_activity sütunu ekle.
--
-- Ses kanalına katılım aktivitesini takip etmek için kullanılır.
-- Platform admin panelde "Son Aktivite" gösterilirken hem mesaj hem ses
-- aktivitesi birlikte değerlendirilir.
ALTER TABLE servers ADD COLUMN last_voice_activity TEXT;
