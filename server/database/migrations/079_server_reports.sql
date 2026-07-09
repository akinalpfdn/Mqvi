-- User reports of a public server (discovery trust & safety). Kept separate from the user-target
-- `reports` table so the existing report flow is untouched. reporter/server cascade-delete.
CREATE TABLE IF NOT EXISTS server_reports (
    id          TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_server_reports_status ON server_reports(status);
CREATE INDEX IF NOT EXISTS idx_server_reports_server ON server_reports(server_id);
