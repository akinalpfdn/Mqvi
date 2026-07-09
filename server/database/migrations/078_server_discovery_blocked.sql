-- Platform-admin unlist flag for the discovery directory. When set, the server never appears in
-- discovery even if its owner has is_public on — the owner cannot override an admin unlist.
ALTER TABLE servers ADD COLUMN discovery_blocked INTEGER NOT NULL DEFAULT 0;
