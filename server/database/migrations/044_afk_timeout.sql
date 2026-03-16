-- AFK voice kick: per-server timeout setting
ALTER TABLE servers ADD COLUMN afk_timeout_minutes INTEGER NOT NULL DEFAULT 60;
