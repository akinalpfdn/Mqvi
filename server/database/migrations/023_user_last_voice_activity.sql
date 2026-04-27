-- Migration 023: Per-user last voice activity tracking.
-- The platform admin panel shows the user's last_activity based on
-- both message and voice channel participation.
ALTER TABLE users ADD COLUMN last_voice_activity TEXT;
