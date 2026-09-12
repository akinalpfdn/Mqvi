package repository

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"testing"
	"time"

	"github.com/akinalp/mqvi/database"
	_ "modernc.org/sqlite"
)

// Real migration chain: the blocked-author exclusion is a subquery against
// friendships, and only the production schema proves the column names.
func newReadStateDB(t *testing.T) (*sql.DB, *sqliteReadStateRepo) {
	t.Helper()
	migFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub migrations: %v", err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "rs.db"), migFS)
	if err != nil {
		t.Fatalf("migrations: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })

	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Conn.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	for _, id := range []string{"author", "blocker", "bystander", "norow_blocker", "norow_bystander"} {
		exec(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, id, id)
	}
	exec(`INSERT INTO servers (id, name, owner_id) VALUES ('s1', 'S', 'author')`)
	exec(`INSERT INTO channels (id, server_id, name, type) VALUES ('c1', 's1', 'general', 'text')`)
	exec(`INSERT INTO channel_reads (user_id, channel_id) VALUES ('blocker', 'c1'), ('bystander', 'c1')`)
	// friendships: user_id = blocker, friend_id = blocked.
	exec(`INSERT INTO friendships (id, user_id, friend_id, status) VALUES ('f1', 'blocker', 'author', 'blocked'), ('f2', 'norow_blocker', 'author', 'blocked')`)
	return db.Conn, &sqliteReadStateRepo{db: db.Conn}
}

func unreadOf(t *testing.T, db *sql.DB, userID string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT unread_count FROM channel_reads WHERE user_id = ? AND channel_id = 'c1'`, userID).Scan(&n); err != nil {
		t.Fatalf("unread of %s: %v", userID, err)
	}
	return n
}

func TestIncrementUnreadCounts_SkipsReadersWhoBlockedTheAuthor(t *testing.T) {
	db, repo := newReadStateDB(t)

	if err := repo.IncrementUnreadCounts(context.Background(), "c1", "author"); err != nil {
		t.Fatalf("increment: %v", err)
	}

	if got := unreadOf(t, db, "bystander"); got != 1 {
		t.Fatalf("bystander unread: want 1, got %d", got)
	}
	if got := unreadOf(t, db, "blocker"); got != 0 {
		t.Fatalf("blocker unread: want 0, got %d", got)
	}
}

func TestDecrementUnreadForDeleted_DoesNotTouchBlockersCounter(t *testing.T) {
	db, repo := newReadStateDB(t)
	ctx := context.Background()

	if err := repo.IncrementUnreadCounts(ctx, "c1", "author"); err != nil {
		t.Fatalf("increment: %v", err)
	}
	// Pretend the blocker read something else meanwhile so a wrong decrement would be visible.
	if _, err := db.Exec(`UPDATE channel_reads SET unread_count = 3 WHERE user_id = 'blocker'`); err != nil {
		t.Fatalf("seed blocker count: %v", err)
	}

	if err := repo.DecrementUnreadForDeleted(ctx, "c1", "author", time.Now()); err != nil {
		t.Fatalf("decrement: %v", err)
	}

	if got := unreadOf(t, db, "bystander"); got != 0 {
		t.Fatalf("bystander unread: want 0, got %d", got)
	}
	if got := unreadOf(t, db, "blocker"); got != 3 {
		t.Fatalf("blocker unread: want 3 (untouched), got %d", got)
	}
}

func TestGetUnreadCounts_FallbackIgnoresBlockedAuthors(t *testing.T) {
	db, repo := newReadStateDB(t)
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('m1', 'c1', 'author', 'hi')`); err != nil {
		t.Fatalf("seed message: %v", err)
	}

	tests := []struct {
		name string
		user string
		want int
	}{
		{"should count the message for a reader without a read-state row", "norow_bystander", 1},
		{"should not count the message for a reader without a row who blocked the author", "norow_blocker", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			infos, err := repo.GetUnreadCounts(ctx, tt.user, "s1")
			if err != nil {
				t.Fatalf("GetUnreadCounts: %v", err)
			}
			got := 0
			for _, info := range infos {
				if info.ChannelID == "c1" {
					got = info.UnreadCount
				}
			}
			if got != tt.want {
				t.Fatalf("want %d, got %d (rows: %+v)", tt.want, got, infos)
			}
		})
	}
}
