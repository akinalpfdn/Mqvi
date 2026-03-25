-- User's preferred presence status (manually chosen).
-- Separate from `status` which is ephemeral (set to 'offline' on disconnect).
-- pref_status persists across sessions and devices.
ALTER TABLE users ADD COLUMN pref_status TEXT NOT NULL DEFAULT 'online';

-- Backfill: users currently online/idle/dnd keep their status as preference
UPDATE users SET pref_status = status WHERE status IN ('online', 'idle', 'dnd');
