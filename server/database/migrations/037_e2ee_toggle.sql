-- E2EE toggle: Enable/disable E2EE per server and per DM.
-- Off by default — users opt in if they want it.

-- Per-server E2EE toggle — owner/admin can change it
ALTER TABLE servers ADD COLUMN e2ee_enabled BOOLEAN NOT NULL DEFAULT 0;

-- Per-DM E2EE toggle — per channel, either party can change it
ALTER TABLE dm_channels ADD COLUMN e2ee_enabled BOOLEAN NOT NULL DEFAULT 0;
