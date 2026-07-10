package database

import (
	"io/fs"
	"path/filepath"
	"strings"
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

// An external-content FTS5 table cannot be pruned with a plain DELETE: it rebuilds the terms
// to remove from the content table, which an AFTER trigger sees already holding the new row.
// Editing a server description returned SQLITE_CORRUPT_VTAB; message edits silently left the
// old text searchable. Migration 081 replaced every such DELETE with the 'delete' command.
func TestEmbeddedMigrations_FTSTriggersUseDeleteCommand(t *testing.T) {
	migFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub migrations: %v", err)
	}
	db, err := New(filepath.Join(t.TempDir(), "fts.db"), migFS)
	if err != nil {
		t.Fatalf("migrations failed to apply: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })

	rows, err := db.Conn.Query(
		`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%_fts%'`)
	if err != nil {
		t.Fatalf("read triggers: %v", err)
	}
	defer rows.Close()

	seen := 0
	for rows.Next() {
		var name, ddl string
		if err := rows.Scan(&name, &ddl); err != nil {
			t.Fatalf("scan trigger: %v", err)
		}
		seen++
		if strings.Contains(strings.ToUpper(ddl), "DELETE FROM") {
			t.Errorf("trigger %s prunes an external-content FTS table with DELETE FROM", name)
		}
	}
	if seen == 0 {
		t.Fatal("no FTS triggers found — the query no longer matches, this test is dead")
	}

	if _, err := db.Conn.Exec(
		`INSERT INTO users (id, username, password_hash) VALUES ('u1','owner','x');
		 INSERT INTO servers (id, name, owner_id, description, is_public) VALUES ('s1','Alpha','u1','old text',1);`,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := db.Conn.Exec(`UPDATE servers SET description = 'brand new text' WHERE id = 's1'`); err != nil {
		t.Fatalf("editing a server description must not fail: %v", err)
	}

	match := func(term string) int {
		var n int
		if err := db.Conn.QueryRow(
			`SELECT count(*) FROM servers_fts WHERE servers_fts MATCH ?`, term).Scan(&n); err != nil {
			t.Fatalf("search %q: %v", term, err)
		}
		return n
	}
	if got := match("brand"); got != 1 {
		t.Errorf("new description must be searchable, got %d hits", got)
	}
	if got := match("old text"); got != 0 {
		t.Errorf("old description must leave the index, got %d hits", got)
	}

	if _, err := db.Conn.Exec(`DELETE FROM servers WHERE id = 's1'`); err != nil {
		t.Fatalf("deleting a server must not fail: %v", err)
	}
	if got := match("brand"); got != 0 {
		t.Errorf("deleted server must leave the index, got %d hits", got)
	}
}
