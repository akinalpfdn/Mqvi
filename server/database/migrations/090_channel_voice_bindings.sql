-- Which LiveKit instance a voice channel's room currently lives on.
--
-- The binding is claimed by the first token request for an empty channel and dropped when the
-- channel empties, so this table is empty except for calls that are actually in progress. It is
-- persisted only to survive a restart: the room name is "{serverID}:{channelID}" and carries no
-- instance identity, so a process that came back with no memory of the binding could send the next
-- joiner to a different instance and split a call that is still running. Nothing would error —
-- both halves work, neither hears the other.
--
-- Deliberately not a column on `channels`: this is session state with a lifetime of minutes, not
-- channel configuration, and `channels` is read by eight hand-written queries that would all have
-- to grow a column they never use.
CREATE TABLE IF NOT EXISTS channel_voice_bindings (
    channel_id  TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    instance_id TEXT NOT NULL REFERENCES livekit_instances(id) ON DELETE CASCADE,
    claimed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Deleting an instance takes its bindings with it (CASCADE above), which is correct: a channel
-- bound to an instance that no longer exists must choose again rather than fail.
CREATE INDEX IF NOT EXISTS idx_channel_voice_bindings_instance
    ON channel_voice_bindings(instance_id);
