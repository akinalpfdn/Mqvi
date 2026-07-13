package repository

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// Minimal slice of the schema MarkRead / CountUnread touch.
func newDMReadTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })

	if _, err := db.Exec(`
		CREATE TABLE dm_messages (
			id TEXT PRIMARY KEY,
			dm_channel_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			created_at DATETIME NOT NULL
		);
		CREATE TABLE dm_reads (
			user_id TEXT NOT NULL,
			dm_channel_id TEXT NOT NULL,
			last_read_message_id TEXT,
			last_read_at DATETIME NOT NULL,
			PRIMARY KEY (user_id, dm_channel_id)
		);
	`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return db
}

// seedConversation writes three messages from "friend" plus one of our own.
func seedConversation(t *testing.T, db *sql.DB) {
	t.Helper()
	rows := [][]any{
		{"m1", "c1", "friend", "2026-07-01 10:00:00"},
		{"m2", "c1", "friend", "2026-07-01 10:01:00"},
		{"m3", "c1", "me", "2026-07-01 10:02:00"}, // our own message is never unread
		{"m4", "c1", "friend", "2026-07-01 10:03:00"},
		{"x1", "c2", "friend", "2026-07-01 10:00:00"}, // a different conversation
	}
	for _, r := range rows {
		if _, err := db.Exec(
			`INSERT INTO dm_messages (id, dm_channel_id, user_id, created_at) VALUES (?, ?, ?, ?)`,
			r...,
		); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
}

func TestDMCountUnread(t *testing.T) {
	db := newDMReadTestDB(t)
	seedConversation(t, db)
	repo := &sqliteDMRepo{db: db}
	ctx := context.Background()

	// Never opened: everything the other person sent is unread, our own message is not.
	got, err := repo.CountUnread(ctx, "me", "c1")
	if err != nil {
		t.Fatalf("CountUnread: %v", err)
	}
	if got != 3 {
		t.Errorf("unread on a never-opened conversation = %d, want 3", got)
	}

	if err := repo.MarkRead(ctx, "me", "c1", "m2"); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	got, err = repo.CountUnread(ctx, "me", "c1")
	if err != nil {
		t.Fatalf("CountUnread: %v", err)
	}
	if got != 1 {
		t.Errorf("unread after reading up to m2 = %d, want 1 (m4)", got)
	}

	if err := repo.MarkRead(ctx, "me", "c1", "m4"); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	got, _ = repo.CountUnread(ctx, "me", "c1")
	if got != 0 {
		t.Errorf("unread after reading to the end = %d, want 0", got)
	}

	// Reading one conversation must not touch another.
	if got, _ = repo.CountUnread(ctx, "me", "c2"); got != 1 {
		t.Errorf("unread in the untouched conversation = %d, want 1", got)
	}
}

// The watermark must never move backwards. A phone and a desktop both mark read, the
// phone's (older) mark lands second — without the guard it would un-read the messages the
// desktop had already cleared, and the notification would come back.
func TestDMMarkReadIsMonotonic(t *testing.T) {
	db := newDMReadTestDB(t)
	seedConversation(t, db)
	repo := &sqliteDMRepo{db: db}
	ctx := context.Background()

	if err := repo.MarkRead(ctx, "me", "c1", "m4"); err != nil { // desktop: read it all
		t.Fatalf("MarkRead: %v", err)
	}
	if err := repo.MarkRead(ctx, "me", "c1", "m1"); err != nil { // phone: a stale mark
		t.Fatalf("MarkRead: %v", err)
	}

	got, err := repo.CountUnread(ctx, "me", "c1")
	if err != nil {
		t.Fatalf("CountUnread: %v", err)
	}
	if got != 0 {
		t.Errorf("a stale mark resurrected %d unread message(s); the watermark went backwards", got)
	}

	var lastID string
	if err := db.QueryRow(
		`SELECT last_read_message_id FROM dm_reads WHERE user_id = 'me' AND dm_channel_id = 'c1'`,
	).Scan(&lastID); err != nil {
		t.Fatalf("read watermark: %v", err)
	}
	if lastID != "m4" {
		t.Errorf("watermark = %q, want m4", lastID)
	}
}

// "Mark as read" from the sidebar: the conversation was never loaded, so there is no
// message id to name and the server has to resolve the newest one itself.
func TestDMMarkReadLatest(t *testing.T) {
	db := newDMReadTestDB(t)
	seedConversation(t, db)
	repo := &sqliteDMRepo{db: db}
	ctx := context.Background()

	if err := repo.MarkReadLatest(ctx, "me", "c1"); err != nil {
		t.Fatalf("MarkReadLatest: %v", err)
	}

	got, err := repo.CountUnread(ctx, "me", "c1")
	if err != nil {
		t.Fatalf("CountUnread: %v", err)
	}
	if got != 0 {
		t.Errorf("unread after marking the whole conversation read = %d, want 0", got)
	}

	// Still monotonic: a stale per-message mark must not undo it.
	if err := repo.MarkRead(ctx, "me", "c1", "m1"); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if got, _ = repo.CountUnread(ctx, "me", "c1"); got != 0 {
		t.Errorf("a stale mark resurrected %d unread message(s)", got)
	}
}

// An empty conversation has nothing to mark; it must not error or invent a watermark.
func TestDMMarkReadLatestOnEmptyConversation(t *testing.T) {
	db := newDMReadTestDB(t)
	repo := &sqliteDMRepo{db: db}
	ctx := context.Background()

	if err := repo.MarkReadLatest(ctx, "me", "empty"); err != nil {
		t.Fatalf("MarkReadLatest on an empty conversation: %v", err)
	}
	if got, _ := repo.CountUnread(ctx, "me", "empty"); got != 0 {
		t.Errorf("unread = %d, want 0", got)
	}
}

// A message id from another conversation must not set this one's watermark.
func TestDMMarkReadRejectsForeignMessage(t *testing.T) {
	db := newDMReadTestDB(t)
	seedConversation(t, db)
	repo := &sqliteDMRepo{db: db}
	ctx := context.Background()

	if err := repo.MarkRead(ctx, "me", "c1", "x1"); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}

	got, _ := repo.CountUnread(ctx, "me", "c1")
	if got != 3 {
		t.Errorf("unread = %d, want 3 — a foreign message id must not mark this channel read", got)
	}
}
