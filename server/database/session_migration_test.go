package database

import (
	"io/fs"
	"path/filepath"
	"testing"
	"time"
)

// Everyone signed in when 098 runs must still be signed in afterwards: their plaintext token
// moves to legacy_token, nothing else about the row changes.
func TestMigration098_KeepsExistingSessionsUsable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mqvi.db")

	before, err := New(path, migrationsUpTo(t, "097_servers_owner_index.sql"))
	if err != nil {
		t.Fatalf("migrate to 097: %v", err)
	}
	expires := time.Now().UTC().Add(48 * time.Hour)
	if _, err := before.Conn.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'u1', 'x')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := before.Conn.Exec(
		`INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES ('s1', 'u1', 'plain-token', ?)`, expires,
	); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if err := before.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	all, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub: %v", err)
	}
	after, err := New(path, all)
	if err != nil {
		t.Fatalf("migrate the rest: %v", err)
	}
	defer func() { _ = after.Close() }() // test cleanup; nothing to recover

	var userID, legacy string
	var tokenHash *string
	var gotExpires time.Time
	if err := after.Conn.QueryRow(
		`SELECT user_id, legacy_token, token_hash, expires_at FROM sessions WHERE id = 's1'`,
	).Scan(&userID, &legacy, &tokenHash, &gotExpires); err != nil {
		t.Fatalf("read migrated session: %v", err)
	}
	if userID != "u1" || legacy != "plain-token" || tokenHash != nil || !gotExpires.Equal(expires) {
		t.Fatalf("migrated row: user=%q legacy=%q hash=%v expires=%v", userID, legacy, tokenHash, gotExpires)
	}

	if _, err := after.Conn.Exec(`DELETE FROM users WHERE id = 'u1'`); err != nil {
		t.Fatalf("delete user: %v", err)
	}
	var left int
	if err := after.Conn.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatal("rebuilt table lost ON DELETE CASCADE from users")
	}
}
