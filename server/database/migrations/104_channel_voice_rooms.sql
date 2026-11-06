-- 104: the LiveKit room name of a channel whose room was rotated.
--
-- LiveKit cannot revoke a token, and it re-issues a fresh one to whoever joins, so a user removed
-- from voice can keep reconnecting with the token they hold. When the reconciliation sweep finds
-- such a user in a room, the channel moves to a new room name and the old room is deleted; every
-- token they hold then names a dead room. The name is written here before it is used, so a restart
-- never sends anyone back to the old room.
--
-- A channel with no row uses the fixed name "{serverID}:{channelID}". Only a rotation writes one,
-- so until the first intrusion nothing about any call changes.
CREATE TABLE IF NOT EXISTS channel_voice_rooms (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    room_name  TEXT NOT NULL,
    rotated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
