package repository

import (
	"context"
	"database/sql"
	"sort"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func openMemDB(t *testing.T, schema string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func queryIDs(t *testing.T, db *sql.DB, query string, args ...any) []string {
	t.Helper()
	rows, err := db.QueryContext(context.Background(), query, args...)
	if err != nil {
		t.Fatalf("query: %v\nSQL: %s", err, query)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func eqIDs(t *testing.T, got, want []string) {
	t.Helper()
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("ids got %v want %v", got, want)
	}
}

// The user filter combines dimensions with AND, statuses/presence with OR, and treats
// admin=both / admin=neither as "no filter".
func TestBuildAdminUserFilter(t *testing.T) {
	db := openMemDB(t, `
		CREATE TABLE users (
			id TEXT PRIMARY KEY, username TEXT, display_name TEXT,
			is_platform_banned INTEGER DEFAULT 0, deleted_at TEXT,
			is_hard_deleted INTEGER DEFAULT 0, status TEXT, is_platform_admin INTEGER DEFAULT 0
		);`)
	// id, banned, deleted_at, hard, presence, admin
	seed := []struct {
		id, presence          string
		banned, hard, isAdmin int
		deleted               any
	}{
		{"u_active", "online", 0, 0, 0, nil},
		{"u_banned", "offline", 1, 0, 0, nil},
		{"u_soft", "idle", 0, 0, 0, "2024-01-01T00:00:00Z"},
		{"u_tomb", "offline", 0, 1, 0, "2024-01-01T00:00:00Z"},
		{"u_admin", "online", 0, 0, 1, nil},
	}
	for _, s := range seed {
		if _, err := db.Exec(
			`INSERT INTO users (id, username, is_platform_banned, deleted_at, is_hard_deleted, status, is_platform_admin)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			s.id, s.id, s.banned, s.deleted, s.hard, s.presence, s.isAdmin,
		); err != nil {
			t.Fatalf("insert %s: %v", s.id, err)
		}
	}

	run := func(statuses, presences, admin []string) []string {
		where, args := buildAdminUserFilter(statuses, presences, admin, "")
		return queryIDs(t, db, "SELECT u.id FROM users u "+where, args...)
	}

	// Empty = all.
	eqIDs(t, run(nil, nil, nil), []string{"u_active", "u_banned", "u_soft", "u_tomb", "u_admin"})
	// Multi-status OR.
	eqIDs(t, run([]string{"banned", "soft_deleted"}, nil, nil), []string{"u_banned", "u_soft"})
	// Presence IN.
	eqIDs(t, run(nil, []string{"online"}, nil), []string{"u_active", "u_admin"})
	// Admin only.
	eqIDs(t, run(nil, nil, []string{"admin"}), []string{"u_admin"})
	// Admin both = no filter (all).
	eqIDs(t, run(nil, nil, []string{"admin", "non_admin"}), []string{"u_active", "u_banned", "u_soft", "u_tomb", "u_admin"})
	// Cross-dimension AND: online AND admin.
	eqIDs(t, run(nil, []string{"online"}, []string{"admin"}), []string{"u_admin"})
}

// The server type filter must match the is_platform_managed CASE used in the SELECT,
// including the "instance id set but instance row missing => managed" edge.
func TestBuildAdminServerFilter_Type(t *testing.T) {
	db := openMemDB(t, `
		CREATE TABLE livekit_instances (id TEXT PRIMARY KEY, is_platform_managed INTEGER DEFAULT 0);
		CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
		CREATE TABLE servers (
			id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, livekit_instance_id TEXT, deleted_at TEXT
		);`)
	if _, err := db.Exec(`
		INSERT INTO livekit_instances (id, is_platform_managed) VALUES ('li_managed', 1), ('li_self', 0);
		INSERT INTO users (id, username) VALUES ('o1', 'owner');
		INSERT INTO servers (id, name, owner_id, livekit_instance_id, deleted_at) VALUES
			('s_managed', 'M', 'o1', 'li_managed', NULL),
			('s_self',    'S', 'o1', 'li_self',    NULL),
			('s_orphan',  'O', 'o1', 'li_gone',    NULL),
			('s_none',    'N', 'o1', NULL,         NULL);
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	run := func(statuses, types []string) []string {
		where, args := buildAdminServerFilter(statuses, types, "")
		q := `SELECT s.id FROM servers s
			LEFT JOIN users u ON s.owner_id = u.id
			LEFT JOIN livekit_instances li ON s.livekit_instance_id = li.id ` + where
		return queryIDs(t, db, q, args...)
	}

	// Managed: explicit managed instance, plus orphaned instance-id (li row missing).
	eqIDs(t, run(nil, []string{"managed"}), []string{"s_managed", "s_orphan"})
	// Self: instance flagged non-managed, plus no instance at all.
	eqIDs(t, run(nil, []string{"self"}), []string{"s_self", "s_none"})
	// Both type values = no filter (all four).
	eqIDs(t, run(nil, []string{"managed", "self"}), []string{"s_managed", "s_self", "s_orphan", "s_none"})
}
