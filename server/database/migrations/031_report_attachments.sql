-- Report attachments — files attached as evidence for a report (images only).
-- Same shape as the existing attachments / dm_attachments tables.
-- FK: reports(id) CASCADE — when a report is deleted, its attachments are deleted too.
CREATE TABLE IF NOT EXISTS report_attachments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
