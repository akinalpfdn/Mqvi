package repository

import (
	"context"
	"testing"

	_ "modernc.org/sqlite"
)

func TestSQLiteJoinRequestRepo(t *testing.T) {
	ctx := context.Background()
	db := openMemDB(t, `
		CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, avatar_url TEXT);
		CREATE TABLE server_join_requests (
			server_id TEXT NOT NULL, user_id TEXT NOT NULL, invite_code TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (server_id, user_id)
		);`)
	repo := NewSQLiteJoinRequestRepo(db)

	if _, err := db.Exec(`INSERT INTO users (id, username) VALUES ('u1','alice'),('u2','bob')`); err != nil {
		t.Fatalf("seed users: %v", err)
	}

	if err := repo.Create(ctx, "s1", "u1", "inv1"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if ok, _ := repo.Exists(ctx, "s1", "u1"); !ok {
		t.Fatal("request should exist after create")
	}

	// Re-request while one is pending is a no-op (idempotent), not an error.
	if err := repo.Create(ctx, "s1", "u1", "inv1"); err != nil {
		t.Fatalf("re-create should be a no-op, got %v", err)
	}
	if n, _ := repo.CountByServer(ctx, "s1"); n != 1 {
		t.Fatalf("count after re-create want 1 got %d", n)
	}

	if err := repo.Create(ctx, "s1", "u2", "inv1"); err != nil {
		t.Fatalf("create u2: %v", err)
	}
	if n, _ := repo.CountByServer(ctx, "s1"); n != 2 {
		t.Fatalf("count want 2 got %d", n)
	}

	list, err := repo.ListByServer(ctx, "s1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("list len want 2 got %d", len(list))
	}
	names := map[string]bool{}
	for _, r := range list {
		names[r.Username] = true
	}
	if !names["alice"] || !names["bob"] {
		t.Fatalf("list missing joined user info: %+v", list)
	}

	// Delete reports whether a row was actually removed (concurrency primitive).
	deleted, err := repo.Delete(ctx, "s1", "u1")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !deleted {
		t.Fatal("delete of an existing request should report true")
	}
	deleted, _ = repo.Delete(ctx, "s1", "u1")
	if deleted {
		t.Fatal("delete of an already-gone request should report false")
	}

	if n, _ := repo.CountByServer(ctx, "s1"); n != 1 {
		t.Fatalf("count after delete want 1 got %d", n)
	}
	if ok, _ := repo.Exists(ctx, "s1", "u1"); ok {
		t.Fatal("deleted request should not exist")
	}
}
