-- 013_friends.sql
-- Arkadaşlık sistemi tablosu.
--
-- Tek tablo, status ile ayrım:
--   "pending"  → istek gönderildi, henüz kabul edilmedi
--   "accepted" → arkadaşlık aktif
--   "blocked"  → kullanıcı engellendi
--
-- user_id: isteği gönderen / engeli koyan
-- friend_id: hedef kullanıcı
-- Accepted durumda çift yönlü sorgu yapılır (user_id VEYA friend_id).

CREATE TABLE IF NOT EXISTS friendships (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    friend_id  TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id)   REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(friend_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, friend_id)
);

-- Sorgularda performans için index'ler:
-- Kullanıcının gelen isteklerini hızlı bulmak (friend_id = me AND status = 'pending')
CREATE INDEX IF NOT EXISTS idx_friendships_friend_status ON friendships(friend_id, status);
-- Kullanıcının gönderdiği istekleri ve arkadaşlarını bulmak
CREATE INDEX IF NOT EXISTS idx_friendships_user_status ON friendships(user_id, status);
