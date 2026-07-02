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
