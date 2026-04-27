-- 022: Add last_voice_activity column to the servers table.
--
-- Used to track voice channel join activity.
-- When the platform admin panel shows "Last Activity", both message and
-- voice activity are considered together.
ALTER TABLE servers ADD COLUMN last_voice_activity TEXT;
