package database

import (
	"io/fs"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// Applies the full embedded migration chain (001..073) on a fresh DB exactly the way
// main.go does, then asserts the newest table + index exist and that FK enforcement is
// actually on for the connection (without it, ON DELETE CASCADE silently no-ops).
func TestEmbeddedMigrations_ApplyClean(t *testing.T) {
	migFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub migrations: %v", err)
	}
	db, err := New(filepath.Join(t.TempDir(), "smoke.db"), migFS)
	if err != nil {
		t.Fatalf("migrations failed to apply: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })

	var name string
	if err := db.Conn.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_ticket_admin_reads'`,
	).Scan(&name); err != nil {
		t.Fatalf("feedback_ticket_admin_reads missing after migrations: %v", err)
	}

	var idx string
	if err := db.Conn.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_feedback_admin_reads_ticket'`,
	).Scan(&idx); err != nil {
		t.Fatalf("idx_feedback_admin_reads_ticket missing after migrations: %v", err)
	}

	var fkOn int
	if err := db.Conn.QueryRow(`PRAGMA foreign_keys`).Scan(&fkOn); err != nil {
		t.Fatalf("pragma foreign_keys: %v", err)
	}
	if fkOn != 1 {
		t.Fatalf("foreign_keys disabled (got %d) — ON DELETE CASCADE would silently no-op", fkOn)
	}

	// Migration 074: join approval table + servers.approval_required column.
	var jr string
	if err := db.Conn.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='server_join_requests'`,
	).Scan(&jr); err != nil {
		t.Fatalf("server_join_requests missing after migrations: %v", err)
	}
	var approvalCol int
	if err := db.Conn.QueryRow(
		`SELECT COUNT(*) FROM pragma_table_info('servers') WHERE name='approval_required'`,
	).Scan(&approvalCol); err != nil {
		t.Fatalf("pragma_table_info(servers): %v", err)
	}
	if approvalCol != 1 {
		t.Fatalf("servers.approval_required column missing after migration 074")
	}
}
