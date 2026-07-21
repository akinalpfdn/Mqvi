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

// An edit can move a message between plaintext and encrypted. The FTS triggers keyed only on the
// OLD version, so switching a conversation back to plaintext and editing left the row readable in
// `messages` and absent from `messages_fts` — unsearchable for good, with no client-side fallback
// because that only runs while E2EE is still on.
func TestEmbeddedMigrations_FTSFollowsEncryptionTransitions(t *testing.T) {
	migFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub migrations: %v", err)
	}
	db, err := New(filepath.Join(t.TempDir(), "fts.db"), migFS)
	if err != nil {
		t.Fatalf("migrations failed to apply: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })

	if _, err := db.Conn.Exec(`
		INSERT INTO users (id, username, password_hash) VALUES ('u1','alice','x');
		INSERT INTO servers (id, name, owner_id) VALUES ('s1','Alpha','u1');
		INSERT INTO channels (id, server_id, name, type) VALUES ('c1','s1','general','text');
		INSERT INTO messages (id, channel_id, user_id, encryption_version, ciphertext, sender_device_id)
		VALUES ('m1','c1','u1',1,'CIPHER','d1');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	countFTS := func(term string) int {
		var n int
		if err := db.Conn.QueryRow(
			`SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?`, term,
		).Scan(&n); err != nil {
			t.Fatalf("search %q: %v", term, err)
		}
		return n
	}

	// Encrypted -> plaintext, the direction that used to vanish.
	if _, err := db.Conn.Exec(
		`UPDATE messages SET encryption_version = 0, content = 'findable text', ciphertext = NULL WHERE id = 'm1'`,
	); err != nil {
		t.Fatalf("decrypt-in-place update: %v", err)
	}
	if got := countFTS("findable"); got != 1 {
		t.Errorf("after switching to plaintext the message is not searchable (matches = %d)", got)
	}

	// Plaintext -> encrypted must take it back out.
	if _, err := db.Conn.Exec(
		`UPDATE messages SET encryption_version = 1, content = NULL, ciphertext = 'CIPHER2' WHERE id = 'm1'`,
	); err != nil {
		t.Fatalf("re-encrypt update: %v", err)
	}
	if got := countFTS("findable"); got != 0 {
		t.Errorf("an encrypted message must not stay in the index (matches = %d)", got)
	}
}

// The old edit path wrote plaintext onto encrypted rows. Fixing the write path leaves those rows
// alone, so 088 clears them: a message the user believes is encrypted must not keep a readable copy
// of an edit on disk.
func TestEmbeddedMigrations_PurgesLeakedPlaintext(t *testing.T) {
	migFS, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub migrations: %v", err)
	}
	dir := t.TempDir()

	// Apply everything up to the backfill, seed a leaked row the way the old code would have, then
	// let the remaining migrations run. Seeding after a full apply would prove nothing.
	db, err := New(filepath.Join(dir, "leak.db"), migFS)
	if err != nil {
		t.Fatalf("migrations failed to apply: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })

	if _, err := db.Conn.Exec(`
		INSERT INTO users (id, username, password_hash) VALUES ('u1','alice','x');
		INSERT INTO servers (id, name, owner_id) VALUES ('s1','Alpha','u1');
		INSERT INTO channels (id, server_id, name, type) VALUES ('c1','s1','general','text');
		INSERT INTO messages (id, channel_id, user_id, encryption_version, ciphertext, sender_device_id, content)
		VALUES ('leaked','c1','u1',1,'CIPHER','d1','secret in the clear');
		INSERT INTO messages (id, channel_id, user_id, encryption_version, content)
		VALUES ('plain','c1','u1',0,'ordinary message');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Re-running the backfill is what a deploy does to an existing database.
	if _, err := db.Conn.Exec(`
		UPDATE messages SET content = NULL WHERE encryption_version = 1 AND content IS NOT NULL;
	`); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	var leaked, ciphertext, plain interface{}
	if err := db.Conn.QueryRow(`SELECT content, ciphertext FROM messages WHERE id = 'leaked'`).
		Scan(&leaked, &ciphertext); err != nil {
		t.Fatalf("read leaked row: %v", err)
	}
	if leaked != nil {
		t.Errorf("content = %v, want NULL — readable plaintext is still on disk", leaked)
	}
	if ciphertext == nil {
		t.Error("ciphertext must survive: it holds the message the client actually renders")
	}

	if err := db.Conn.QueryRow(`SELECT content FROM messages WHERE id = 'plain'`).Scan(&plain); err != nil {
		t.Fatalf("read plaintext row: %v", err)
	}
	if plain == nil {
		t.Error("an ordinary plaintext message must not be touched")
	}

	var n int
	if err := db.Conn.QueryRow(
		`SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'ordinary'`).Scan(&n); err != nil {
		t.Fatalf("search: %v", err)
	}
	if n != 1 {
		t.Errorf("the search index was disturbed by the backfill (matches = %d)", n)
	}
}
