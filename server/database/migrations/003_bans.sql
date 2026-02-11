-- 003_bans.sql
-- Ban sistemi: yasaklanmış kullanıcılar tablosu.
--
-- Bir kullanıcı banlandığında bu tabloya kayıt oluşturulur.
-- Login ve WS bağlantısı sırasında bu tablo kontrol edilir.
-- Unban = kayıt silinir.

CREATE TABLE IF NOT EXISTS bans (
    user_id    TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    reason     TEXT DEFAULT '',
    banned_by  TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
