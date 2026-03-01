-- 019: server_members tablosuna position kolonu ekle.
--
-- Her kullanıcı kendi sunucu listesini sürükleyerek sıralayabilir.
-- Position değeri per-user'dır — başka kullanıcıları etkilemez.
-- Mevcut satırlar joined_at sırasıyla position alır (0-based).
-- Yeni üyeler MAX(position)+1 ile eklenir (AddMember'da).

ALTER TABLE server_members ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- Mevcut satırlara joined_at sırasıyla position ata.
-- SQLite'da UPDATE ... SET = (SELECT ROW_NUMBER()) desteklenmediği için
-- her satıra (user_id, server_id) bazında sıralı değer atamamız lazım.
-- Basit yaklaşım: her kullanıcının sunucularını joined_at'a göre sırala
-- ve 0'dan başlayarak position ver.
--
-- CTe (Common Table Expression) ile yapıyoruz:
UPDATE server_members
SET position = (
    SELECT COUNT(*)
    FROM server_members sm2
    WHERE sm2.user_id = server_members.user_id
      AND sm2.joined_at < server_members.joined_at
);
