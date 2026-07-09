-- Server join approval: a per-server toggle plus a pending-request table.
-- Pending users live ONLY in server_join_requests, never in server_members, so every
-- existing access check (membership middleware, WS, fileacl, voice, broadcasts) denies
-- them with no changes. Approval promotes them through the normal join path.
ALTER TABLE servers ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS server_join_requests (
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_server_join_requests_server ON server_join_requests(server_id);
