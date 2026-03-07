-- E2EE toggle: Server ve DM bazinda E2EE acma/kapatma.
-- Default kapali — kullanicilar isterse acar.

-- Server bazli E2EE toggle — owner/admin degistirebilir
ALTER TABLE servers ADD COLUMN e2ee_enabled BOOLEAN NOT NULL DEFAULT 0;

-- DM bazli E2EE toggle — kanal bazinda, her iki taraf degistirebilir
ALTER TABLE dm_channels ADD COLUMN e2ee_enabled BOOLEAN NOT NULL DEFAULT 0;
