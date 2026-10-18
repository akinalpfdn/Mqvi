-- 097: Servers looked up by owner (the onboarding guide's "create a role" step, ownership checks).
CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id);
