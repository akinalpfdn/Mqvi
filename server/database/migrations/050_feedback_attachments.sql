-- Ensure feedback_attachments table exists with reply_id support.
CREATE TABLE IF NOT EXISTS feedback_attachments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
    reply_id TEXT REFERENCES feedback_replies(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_attachments_ticket ON feedback_attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_feedback_attachments_reply ON feedback_attachments(reply_id);
