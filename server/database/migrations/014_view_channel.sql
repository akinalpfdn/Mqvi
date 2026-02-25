-- 014_view_channel.sql
-- PermViewChannel (bit 4096) yetkisini tüm mevcut rollere ekler.
-- Bu yetki kanal görünürlüğünü kontrol eder — deny edilirse kanal sidebar'da gizlenir.
-- Tüm mevcut roller varsayılan olarak kanalları görebilmeli.
UPDATE roles SET permissions = permissions | 4096;
