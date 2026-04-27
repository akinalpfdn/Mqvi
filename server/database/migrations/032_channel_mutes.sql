-- 032: Channel mute — per-user channel muting.
--
-- muted_until: NULL = forever (until explicitly unmuted)
--              DATETIME = until a specific time (1h, 8h, 7d)
-- Expired mutes are cleaned up lazily — checked on read.
-- server_id is denormalized for query optimization (FK cascade still works through channel).

CREATE TABLE IF NOT EXISTS channel_mutes (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    muted_until DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
);
