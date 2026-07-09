-- Per-admin, per-ticket read tracking for the admin feedback datagrid.
-- A ticket is "unread" for an admin when its latest non-admin activity
-- (ticket creation or a user reply) is newer than that admin's last_seen_at.
CREATE TABLE IF NOT EXISTS feedback_ticket_admin_reads (
    admin_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticket_id    TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (admin_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_admin_reads_ticket ON feedback_ticket_admin_reads(ticket_id);
