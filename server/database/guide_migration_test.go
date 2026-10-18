package database

import (
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// migrationsUpTo is the embedded migrations whose file names sort at or before `last`.
func migrationsUpTo(t *testing.T, last string) fs.FS {
	t.Helper()
	all, err := fs.Sub(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub: %v", err)
	}
	entries, err := fs.ReadDir(all, ".")
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	subset := fstest.MapFS{}
	for _, e := range entries {
		if e.Name() > last {
			continue
		}
		data, err := fs.ReadFile(all, e.Name())
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		subset[e.Name()] = &fstest.MapFile{Data: data}
	}
	return subset
}

// The guide is for new accounts: whoever exists when 096 runs gets it hidden, whoever signs up
// afterwards does not.
func TestMigration096_HidesTheGuideOnlyForAccountsThatAlreadyExist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mqvi.db")

	before, err := New(path, migrationsUpTo(t, "095_user_guide_hidden.sql"))
	if err != nil {
		t.Fatalf("migrate to 095: %v", err)
	}
	if _, err := before.Conn.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('old', 'old', 'x')`); err != nil {
		t.Fatalf("seed: %v", err)
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
	if _, err := after.Conn.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('new', 'new', 'x')`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	hidden := map[string]bool{}
	rows, err := after.Conn.Query(`SELECT id, guide_hidden FROM users`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer func() { _ = rows.Close() }() // test cleanup; nothing to recover
	for rows.Next() {
		var id string
		var h bool
		if err := rows.Scan(&id, &h); err != nil {
			t.Fatalf("scan: %v", err)
		}
		hidden[id] = h
	}
	if !hidden["old"] {
		t.Fatal("an account that existed before 096 must have the guide hidden")
	}
	if hidden["new"] {
		t.Fatal("an account created after 096 must see the guide")
	}
}
