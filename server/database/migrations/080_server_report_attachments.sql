-- Evidence images for server reports (parallel to report_attachments). Cascade-deletes with the
-- report. Images only (enforced in the upload service).
CREATE TABLE IF NOT EXISTS server_report_attachments (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    server_report_id TEXT NOT NULL REFERENCES server_reports(id) ON DELETE CASCADE,
    filename         TEXT NOT NULL,
    file_url         TEXT NOT NULL,
    file_size        INTEGER,
    mime_type        TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_server_report_attachments_report ON server_report_attachments(server_report_id);
