package repository

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"

	"github.com/akinalp/mqvi/pkg"
	_ "modernc.org/sqlite"
)

func newInviteRepoTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	// Single shared connection: :memory: is per-connection, and it also lets goroutines
	// contend on one database instead of each getting a private empty one.
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`
		CREATE TABLE invites (
			code TEXT PRIMARY KEY,
			server_id TEXT NOT NULL,
			created_by TEXT,
			max_uses INTEGER NOT NULL DEFAULT 0,
			uses INTEGER NOT NULL DEFAULT 0,
			expires_at DATETIME,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return db
}

// Phase 48-A #2 — Delete is scoped to the invite's server: deleting by code via another
// server's route must not touch the invite (IDOR), and returns ErrNotFound (no oracle).
func TestSQLiteInviteRepo_Delete_ServerScoped(t *testing.T) {
	ctx := context.Background()
	db := newInviteRepoTestDB(t)
	repo := NewSQLiteInviteRepo(db)
	if _, err := db.ExecContext(ctx, `INSERT INTO invites (code, server_id, max_uses, uses) VALUES ('inv1', 'srv-A', 0, 0)`); err != nil {
		t.Fatalf("insert invite: %v", err)
	}

	countInvite := func() int {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM invites WHERE code='inv1'`).Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}

	// Cross-server delete: must be a no-op returning ErrNotFound; invite survives.
	if err := repo.Delete(ctx, "srv-B", "inv1"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-server delete should return ErrNotFound, got %v", err)
	}
	if countInvite() != 1 {
		t.Fatal("invite must survive a cross-server delete")
	}

	// Owning server deletes it successfully.
	if err := repo.Delete(ctx, "srv-A", "inv1"); err != nil {
		t.Fatalf("same-server delete should succeed, got %v", err)
	}
	if countInvite() != 0 {
		t.Fatal("invite should be deleted by its own server")
	}
}

// Phase 48-A #5 — DecrementUses compensates a consumed use (join failed post-Consume) and
// is floored at 0 so it can never go negative.
func TestSQLiteInviteRepo_DecrementUses(t *testing.T) {
	ctx := context.Background()
	db := newInviteRepoTestDB(t)
	repo := NewSQLiteInviteRepo(db)
	if _, err := db.ExecContext(ctx, `INSERT INTO invites (code, server_id, max_uses, uses) VALUES ('inv1', 'srv-A', 5, 1)`); err != nil {
		t.Fatalf("insert invite: %v", err)
	}

	uses := func() int {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT uses FROM invites WHERE code='inv1'`).Scan(&n); err != nil {
			t.Fatalf("select uses: %v", err)
		}
		return n
	}

	if err := repo.DecrementUses(ctx, "inv1"); err != nil {
		t.Fatalf("decrement: %v", err)
	}
	if uses() != 0 {
		t.Fatalf("expected uses=0 after decrement, got %d", uses())
	}
	// Already at 0 → no-op, not an error, never negative.
	if err := repo.DecrementUses(ctx, "inv1"); err != nil {
		t.Fatalf("decrement at 0 should be a no-op, got %v", err)
	}
	if uses() != 0 {
		t.Fatalf("uses must not go negative, got %d", uses())
	}
}

// B1 regression: concurrent joins on a max_uses=1 invite must not exceed the cap. The
// conditional UPDATE guard means exactly one caller consumes the slot; the rest match 0
// rows and get ErrConflict.
func TestSQLiteInviteRepo_IncrementUses_AtomicMaxUses(t *testing.T) {
	ctx := context.Background()
	db := newInviteRepoTestDB(t)
	repo := NewSQLiteInviteRepo(db)
	if _, err := db.ExecContext(ctx, `INSERT INTO invites (code, server_id, max_uses, uses) VALUES ('inv1', 'srv1', 1, 0)`); err != nil {
		t.Fatalf("insert invite: %v", err)
	}

	const goroutines = 8
	results := make(chan error, goroutines)
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- repo.IncrementUses(ctx, "inv1")
		}()
	}
	wg.Wait()
	close(results)

	var success, conflict int
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, pkg.ErrConflict):
			conflict++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if success != 1 {
		t.Fatalf("exactly one join should succeed, got %d", success)
	}
	if conflict != goroutines-1 {
		t.Fatalf("remaining joins should conflict, got %d want %d", conflict, goroutines-1)
	}

	var uses int
	if err := db.QueryRowContext(ctx, `SELECT uses FROM invites WHERE code = 'inv1'`).Scan(&uses); err != nil {
		t.Fatalf("select uses: %v", err)
	}
	if uses != 1 {
		t.Fatalf("uses got %d want 1 (cap must not be exceeded)", uses)
	}
}

// Unlimited invites (max_uses=0) keep incrementing — the guard must not block them.
func TestSQLiteInviteRepo_IncrementUses_Unlimited(t *testing.T) {
	ctx := context.Background()
	db := newInviteRepoTestDB(t)
	repo := NewSQLiteInviteRepo(db)
	if _, err := db.ExecContext(ctx, `INSERT INTO invites (code, server_id, max_uses, uses) VALUES ('inv0', 'srv1', 0, 0)`); err != nil {
		t.Fatalf("insert invite: %v", err)
	}

	for i := 0; i < 5; i++ {
		if err := repo.IncrementUses(ctx, "inv0"); err != nil {
			t.Fatalf("increment %d: %v", i, err)
		}
	}

	var uses int
	if err := db.QueryRowContext(ctx, `SELECT uses FROM invites WHERE code = 'inv0'`).Scan(&uses); err != nil {
		t.Fatalf("select uses: %v", err)
	}
	if uses != 5 {
		t.Fatalf("uses got %d want 5", uses)
	}
}
