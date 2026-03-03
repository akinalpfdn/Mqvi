-- 032: Channel mute — kullanıcı bazlı kanal sessize alma.
--
-- muted_until: NULL = sonsuza kadar (unmute edilene kadar)
--              DATETIME = belirli bir zamana kadar (1h, 8h, 7d)
-- Süresi dolan mute'lar lazy olarak temizlenir: okunurken kontrol edilir.
-- server_id sorgu optimizasyonu için tutulur (FK cascade channel üzerinden zaten çalışır).

CREATE TABLE IF NOT EXISTS channel_mutes (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    muted_until DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
);
