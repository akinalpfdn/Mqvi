-- 029_dm_settings.sql
-- Kullanıcı bazlı DM kanalı ayarları: gizleme (hide), sabitleme (pin), sessize alma (mute).
-- Tek tablo ile 3 özellik birleştirilir — aynı PK (user_id, dm_channel_id).
-- UPSERT pattern kullanılır (INSERT ... ON CONFLICT DO UPDATE).

CREATE TABLE IF NOT EXISTS user_dm_settings (
    user_id       TEXT NOT NULL,
    dm_channel_id TEXT NOT NULL,
    is_hidden     INTEGER NOT NULL DEFAULT 0,
    is_pinned     INTEGER NOT NULL DEFAULT 0,
    muted_until   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, dm_channel_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (dm_channel_id) REFERENCES dm_channels(id) ON DELETE CASCADE
);
