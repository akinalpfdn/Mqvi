-- Feedback ticket system: user-submitted bugs, suggestions, questions.
CREATE TABLE IF NOT EXISTS feedback_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('bug', 'suggestion', 'question', 'other')),
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS feedback_replies (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    is_admin INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_feedback_tickets_user ON feedback_tickets(user_id);
CREATE INDEX idx_feedback_tickets_status ON feedback_tickets(status);
CREATE INDEX idx_feedback_replies_ticket ON feedback_replies(ticket_id);
