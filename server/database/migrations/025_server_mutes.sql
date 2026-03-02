-- 025: Server mute — kullanıcı bazlı sunucu bildirim sessize alma.
--
-- muted_until: NULL = sonsuza kadar (unmute edilene kadar)
--              DATETIME = belirli bir zamana kadar (1h, 8h, 7d)
-- Süresi dolan mute'lar lazy olarak temizlenir: okunurken kontrol edilir.

CREATE TABLE IF NOT EXISTS server_mutes (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    muted_until DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, server_id)
);
