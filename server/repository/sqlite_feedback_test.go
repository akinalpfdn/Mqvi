package repository

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func newFeedbackRepoTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL,
			display_name TEXT
		);
		CREATE TABLE feedback_tickets (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			type TEXT NOT NULL,
			subject TEXT NOT NULL,
			content TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE feedback_replies (
			id TEXT PRIMARY KEY,
			ticket_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			is_admin INTEGER NOT NULL DEFAULT 0,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE feedback_ticket_admin_reads (
			admin_id TEXT NOT NULL,
			ticket_id TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			PRIMARY KEY (admin_id, ticket_id)
		);
	`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return db
}

func seedTicket(t *testing.T, db *sql.DB, id, userID, ttype, subject, status, createdAt string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO feedback_tickets (id, user_id, type, subject, content, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'body', ?, ?, ?)`,
		id, userID, ttype, subject, status, createdAt, createdAt,
	); err != nil {
		t.Fatalf("insert ticket %s: %v", id, err)
	}
}

// Unread is per-ticket, per-admin: a fresh ticket is unread, opening it clears the dot,
// and a later NON-admin reply re-arms it while an admin reply does not.
func TestSQLiteFeedbackRepo_ListAllForAdmin_Unread(t *testing.T) {
	ctx := context.Background()
	db := newFeedbackRepoTestDB(t)
	repo := NewSQLiteFeedbackRepo(db)

	if _, err := db.Exec(`INSERT INTO users (id, username) VALUES ('u1', 'alice'), ('admin', 'root')`); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	seedTicket(t, db, "t1", "u1", "bug", "Alpha", "open", "2024-01-01T00:00:00.000Z")
	seedTicket(t, db, "t2", "u1", "bug", "Beta", "open", "2024-01-02T00:00:00.000Z")

	unreadByID := func() map[string]bool {
		tickets, _, err := repo.ListAllForAdmin(ctx, FeedbackListParams{AdminID: "admin", Limit: 50})
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		m := map[string]bool{}
		for _, tk := range tickets {
			m[tk.ID] = tk.IsUnread
		}
		return m
	}

	// No read rows yet → every ticket is unread.
	if u := unreadByID(); !u["t1"] || !u["t2"] {
		t.Fatalf("fresh tickets must be unread, got %v", u)
	}

	// Admin opens t1 (after its creation) → t1 read, t2 still unread.
	if _, err := db.Exec(`INSERT INTO feedback_ticket_admin_reads (admin_id, ticket_id, last_seen_at)
		VALUES ('admin', 't1', '2024-01-03T00:00:00.000Z')`); err != nil {
		t.Fatalf("seed read: %v", err)
	}
	if u := unreadByID(); u["t1"] || !u["t2"] {
		t.Fatalf("t1 should be read, t2 unread, got %v", u)
	}

	// A later admin reply must NOT re-arm the dot (admin's own activity).
	if _, err := db.Exec(`INSERT INTO feedback_replies (id, ticket_id, user_id, is_admin, content, created_at)
		VALUES ('r1', 't1', 'admin', 1, 'reply', '2024-01-04T00:00:00.000Z')`); err != nil {
		t.Fatalf("admin reply: %v", err)
	}
	if u := unreadByID(); u["t1"] {
		t.Fatalf("admin reply must not mark t1 unread, got %v", u)
	}

	// A later NON-admin (user) reply DOES re-arm the dot.
	if _, err := db.Exec(`INSERT INTO feedback_replies (id, ticket_id, user_id, is_admin, content, created_at)
		VALUES ('r2', 't1', 'u1', 0, 'reply', '2024-01-05T00:00:00.000Z')`); err != nil {
		t.Fatalf("user reply: %v", err)
	}
	if u := unreadByID(); !u["t1"] {
		t.Fatalf("user reply must re-arm t1 unread, got %v", u)
	}
}

// Multi-select status filter is OR-combined; empty means all.
func TestSQLiteFeedbackRepo_ListAllForAdmin_MultiStatusFilter(t *testing.T) {
	ctx := context.Background()
	db := newFeedbackRepoTestDB(t)
	repo := NewSQLiteFeedbackRepo(db)

	if _, err := db.Exec(`INSERT INTO users (id, username) VALUES ('u1', 'alice')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	seedTicket(t, db, "t1", "u1", "bug", "A", "open", "2024-01-01T00:00:00.000Z")
	seedTicket(t, db, "t2", "u1", "bug", "B", "closed", "2024-01-02T00:00:00.000Z")
	seedTicket(t, db, "t3", "u1", "bug", "C", "resolved", "2024-01-03T00:00:00.000Z")

	tickets, total, err := repo.ListAllForAdmin(ctx, FeedbackListParams{
		AdminID:  "admin",
		Statuses: []string{"open", "closed"},
		Limit:    50,
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 2 || len(tickets) != 2 {
		t.Fatalf("expected 2 tickets (open+closed), got total=%d len=%d", total, len(tickets))
	}
	for _, tk := range tickets {
		if tk.Status != "open" && tk.Status != "closed" {
			t.Fatalf("unexpected status %q in filtered result", tk.Status)
		}
	}
}

// Sorting honors the whitelisted key + direction; an unknown key falls back to created_at.
func TestSQLiteFeedbackRepo_ListAllForAdmin_Sort(t *testing.T) {
	ctx := context.Background()
	db := newFeedbackRepoTestDB(t)
	repo := NewSQLiteFeedbackRepo(db)

	if _, err := db.Exec(`INSERT INTO users (id, username) VALUES ('u1', 'alice')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	seedTicket(t, db, "t1", "u1", "bug", "Charlie", "open", "2024-01-01T00:00:00.000Z")
	seedTicket(t, db, "t2", "u1", "bug", "alpha", "open", "2024-01-02T00:00:00.000Z")
	seedTicket(t, db, "t3", "u1", "bug", "Bravo", "open", "2024-01-03T00:00:00.000Z")

	tickets, _, err := repo.ListAllForAdmin(ctx, FeedbackListParams{
		AdminID: "admin",
		SortKey: "subject",
		SortDir: "asc",
		Limit:   50,
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// COLLATE NOCASE → alpha, Bravo, Charlie
	want := []string{"alpha", "Bravo", "Charlie"}
	for i, tk := range tickets {
		if tk.Subject != want[i] {
			t.Fatalf("sort by subject asc: pos %d got %q want %q", i, tk.Subject, want[i])
		}
	}

	// Unknown sort key must not error — it falls back to created_at DESC.
	if _, _, err := repo.ListAllForAdmin(ctx, FeedbackListParams{
		AdminID: "admin", SortKey: "injection; DROP TABLE", SortDir: "asc", Limit: 50,
	}); err != nil {
		t.Fatalf("unknown sort key should be ignored, got %v", err)
	}
}

// MarkTicketSeen is an idempotent upsert — a second call updates rather than errors.
func TestSQLiteFeedbackRepo_MarkTicketSeen_Idempotent(t *testing.T) {
	ctx := context.Background()
	db := newFeedbackRepoTestDB(t)
	repo := NewSQLiteFeedbackRepo(db)

	if err := repo.MarkTicketSeen(ctx, "admin", "t1"); err != nil {
		t.Fatalf("first mark: %v", err)
	}
	if err := repo.MarkTicketSeen(ctx, "admin", "t1"); err != nil {
		t.Fatalf("second mark should be a no-conflict upsert, got %v", err)
	}
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM feedback_ticket_admin_reads WHERE admin_id='admin' AND ticket_id='t1'`,
	).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly one read row, got %d", n)
	}
}
