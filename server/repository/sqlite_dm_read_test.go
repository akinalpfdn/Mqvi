package repository

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	_ "modernc.org/sqlite"
)

// These tests run against the REAL migration chain and insert through the REAL CreateMessage
// path, so created_at comes from CURRENT_TIMESTAMP exactly as it does in production.
//
// The previous version of this file hand-built its own dm_messages table with
// `created_at DATETIME NOT NULL` and seeded timestamps a minute apart. Everything passed —
// against a schema that does not exist. It missed a message-loss bug and a migration that
// would have shown every user their entire DM history as unread.
func newDMReadDB(t *testing.T) (*sql.DB, *sqliteDMRepo) {
	t.Helper()
	migFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub migrations: %v", err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "dm.db"), migFS)
	if err != nil {
		t.Fatalf("migrations: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })

	for _, id := range []string{"me", "friend"} {
		if _, err := db.Conn.Exec(
			`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, id, id,
		); err != nil {
			t.Fatalf("seed user %s: %v", id, err)
		}
	}
	if _, err := db.Conn.Exec(
		`INSERT INTO dm_channels (id, user1_id, user2_id) VALUES ('c1','friend','me')`,
	); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	return db.Conn, &sqliteDMRepo{db: db.Conn}
}

// send writes a message the way the app does — no explicit created_at.
func send(t *testing.T, repo *sqliteDMRepo, from, content string) string {
	t.Helper()
	msg := &models.DMMessage{DMChannelID: "c1", UserID: from, Content: &content}
	if err := repo.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return msg.ID
}

// THE bug this whole tie-break exists for. created_at is whole seconds, so two messages sent
// in the same second are identical on it. Reading the first must not swallow the second —
// if it does, the badge never appears AND the server retracts the message's push notification.
func TestDMUnread_SameSecondMessagesAreNotSwallowed(t *testing.T) {
	db, repo := newDMReadDB(t)
	ctx := context.Background()

	m1 := send(t, repo, "friend", "first")
	m2 := send(t, repo, "friend", "second")

	var t1, t2 string
	db.QueryRow(`SELECT created_at FROM dm_messages WHERE id=?`, m1).Scan(&t1)
	db.QueryRow(`SELECT created_at FROM dm_messages WHERE id=?`, m2).Scan(&t2)
	if t1 != t2 {
		t.Skipf("clock ticked between inserts (%s vs %s) — this test needs both in one second", t1, t2)
	}

	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 2 {
		t.Fatalf("unread = %d, want 2", n)
	}

	// Read only the first one.
	if _, err := repo.MarkRead(ctx, "me", "c1", m1); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}

	n, err := repo.CountUnread(ctx, "me", "c1")
	if err != nil {
		t.Fatalf("CountUnread: %v", err)
	}
	if n != 1 {
		t.Errorf("unread = %d, want 1 — the second message was never seen and must still count", n)
	}
}

// A message arriving in the same second as the watermark must still be able to become unread.
func TestDMUnread_MessageInTheWatermarkSecond(t *testing.T) {
	db, repo := newDMReadDB(t)
	ctx := context.Background()

	m1 := send(t, repo, "friend", "first")
	if _, err := repo.MarkRead(ctx, "me", "c1", m1); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	m2 := send(t, repo, "friend", "second")

	var t1, t2 string
	db.QueryRow(`SELECT created_at FROM dm_messages WHERE id=?`, m1).Scan(&t1)
	db.QueryRow(`SELECT created_at FROM dm_messages WHERE id=?`, m2).Scan(&t2)
	if t1 != t2 {
		t.Skipf("clock ticked between inserts — this test needs both in one second")
	}

	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 1 {
		t.Errorf("unread = %d, want 1 — a message can arrive in the same second as the watermark", n)
	}
}

func TestDMUnread_CountsAndMarks(t *testing.T) {
	_, repo := newDMReadDB(t)
	ctx := context.Background()

	send(t, repo, "friend", "a")
	m2 := send(t, repo, "friend", "b")
	send(t, repo, "me", "mine") // our own message is never unread
	send(t, repo, "friend", "c")

	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 3 {
		t.Fatalf("unread = %d, want 3 (our own message must not count)", n)
	}

	moved, err := repo.MarkRead(ctx, "me", "c1", m2)
	if err != nil || !moved {
		t.Fatalf("MarkRead: moved=%v err=%v", moved, err)
	}
	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 1 {
		t.Errorf("unread after reading to b = %d, want 1", n)
	}

	if moved, _ := repo.MarkReadLatest(ctx, "me", "c1"); !moved {
		t.Error("MarkReadLatest should have moved the watermark")
	}
	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 0 {
		t.Errorf("unread after reading everything = %d, want 0", n)
	}
}

// Re-marking the same position must report "did not move", or every sidebar click broadcasts
// to all the user's devices and fires a push to their phone.
func TestDMMarkRead_ReportsWhetherItMoved(t *testing.T) {
	_, repo := newDMReadDB(t)
	ctx := context.Background()

	m1 := send(t, repo, "friend", "a")

	moved, _ := repo.MarkRead(ctx, "me", "c1", m1)
	if !moved {
		t.Fatal("first mark must move the watermark")
	}
	moved, _ = repo.MarkRead(ctx, "me", "c1", m1)
	if moved {
		t.Error("re-marking the same message must report no movement")
	}
	moved, _ = repo.MarkReadLatest(ctx, "me", "c1")
	if moved {
		t.Error("marking an already-read conversation must report no movement")
	}
}

// The watermark must never move backwards: a stale mark from a second device would otherwise
// un-read what the first device already cleared, and the notification would come back.
func TestDMMarkRead_IsMonotonic(t *testing.T) {
	_, repo := newDMReadDB(t)
	ctx := context.Background()

	m1 := send(t, repo, "friend", "a")
	send(t, repo, "friend", "b")

	if _, err := repo.MarkReadLatest(ctx, "me", "c1"); err != nil { // desktop reads it all
		t.Fatal(err)
	}
	if moved, _ := repo.MarkRead(ctx, "me", "c1", m1); moved { // phone: a stale mark
		t.Error("a stale mark must not move the watermark backwards")
	}
	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 0 {
		t.Errorf("a stale mark resurrected %d unread message(s)", n)
	}
}

func TestDMMarkRead_RejectsForeignMessage(t *testing.T) {
	db, repo := newDMReadDB(t)
	ctx := context.Background()

	db.Exec(`INSERT INTO dm_channels (id, user1_id, user2_id) VALUES ('c2','me','friend')`)
	other := &models.DMMessage{DMChannelID: "c2", UserID: "friend"}
	if err := repo.CreateMessage(ctx, other); err != nil {
		t.Fatal(err)
	}
	send(t, repo, "friend", "a")

	if moved, _ := repo.MarkRead(ctx, "me", "c1", other.ID); moved {
		t.Error("a message id from another channel must not move this channel's watermark")
	}
	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 1 {
		t.Errorf("unread = %d, want 1", n)
	}
}

// A finished call writes a message_type='call' log row authored by the caller. It is not a
// message and must not leave a badge sitting on the conversation forever.
func TestDMUnread_IgnoresCallLogs(t *testing.T) {
	_, repo := newDMReadDB(t)
	ctx := context.Background()

	msg := &models.DMMessage{DMChannelID: "c1", UserID: "friend", MessageType: models.MessageTypeCall}
	if err := repo.CreateMessage(ctx, msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 0 {
		t.Errorf("unread = %d, want 0 — a call log is not an unread message", n)
	}
}

// Migration 082 must treat existing history as read. Without the backfill, a missing watermark
// means "has read nothing", and every user would open the app to their whole DM history sitting
// there as unread. This runs the migration file's own SQL — not a copy — against seeded history.
func TestDMUnread_MigrationBackfillsExistingHistory(t *testing.T) {
	db, repo := newDMReadDB(t)
	ctx := context.Background()

	// Simulate a live DB from before 082: history exists, no read state.
	for i := 0; i < 25; i++ {
		send(t, repo, "friend", "old message")
	}
	if _, err := db.Exec(`DELETE FROM dm_reads`); err != nil {
		t.Fatalf("reset read state: %v", err)
	}
	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 25 {
		t.Fatalf("precondition: unread = %d, want 25 (this is what users would see WITHOUT the backfill)", n)
	}

	// Run the migration's own SQL, not a copy — a copy would drift from the file.
	// (Only the backfill half; the ALTER already ran with the rest of the chain.)
	sqlBytes, err := database.EmbeddedMigrations.ReadFile("migrations/083_dm_reads_seq.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	_, backfill, found := strings.Cut(string(sqlBytes), "INSERT INTO dm_reads")
	if !found {
		t.Fatal("083 no longer contains the backfill INSERT — this test is out of date")
	}
	if _, err := db.Exec("INSERT INTO dm_reads" + backfill); err != nil {
		t.Fatalf("apply 083 backfill: %v", err)
	}

	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 0 {
		t.Errorf("unread after backfill = %d, want 0 — existing history must not resurface as unread", n)
	}
	// And the other participant is backfilled too, not just one side.
	if n, _ := repo.CountUnread(ctx, "friend", "c1"); n != 0 {
		t.Errorf("the other participant's unread = %d, want 0", n)
	}
	// Backfill is idempotent — re-running it must not move anything.
	if _, err := db.Exec("INSERT INTO dm_reads" + backfill); err != nil {
		t.Fatalf("re-apply backfill: %v", err)
	}
	// A message arriving AFTER the backfill must still count.
	send(t, repo, "friend", "new")
	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 1 {
		t.Errorf("unread after a new message = %d, want 1", n)
	}
}

// Canary. The read watermark keys on dm_messages.rowid, and so does DM search —
// dm_messages_fts is external-content with content_rowid='rowid'. SQLite's docs reserve the
// right to renumber rowids on VACUUM for a table without an INTEGER PRIMARY KEY, which
// dm_messages is. If that ever starts happening, search breaks and every watermark repoints;
// this test is where it should surface first.
func TestDMUnread_SurvivesVacuum(t *testing.T) {
	db, repo := newDMReadDB(t)
	ctx := context.Background()

	// Leave a rowid gap so a rebuild has something to compact.
	var junk []string
	for i := 0; i < 6; i++ {
		m := &models.DMMessage{DMChannelID: "c1", UserID: "friend"}
		if err := repo.CreateMessage(ctx, m); err != nil {
			t.Fatal(err)
		}
		junk = append(junk, m.ID)
	}
	for _, id := range junk[:3] {
		if _, err := db.Exec(`DELETE FROM dm_messages WHERE id = ?`, id); err != nil {
			t.Fatal(err)
		}
	}

	read := junk[4]
	if _, err := repo.MarkRead(ctx, "me", "c1", read); err != nil {
		t.Fatal(err)
	}
	before, err := repo.CountUnread(ctx, "me", "c1")
	if err != nil {
		t.Fatal(err)
	}
	if before != 1 {
		t.Fatalf("precondition: unread = %d, want 1", before)
	}

	if _, err := db.Exec(`VACUUM`); err != nil {
		t.Fatalf("VACUUM: %v", err)
	}

	after, err := repo.CountUnread(ctx, "me", "c1")
	if err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Errorf("unread went from %d to %d across a VACUUM — the watermark was repointed", before, after)
	}
}

// A user who already has a read position must KEEP it. The first cut of 083 used
// ON CONFLICT DO UPDATE, which fast-forwarded every existing watermark to the newest message —
// silently marking unread messages read for anyone who had already run 082.
func TestDMUnread_BackfillPreservesAnExistingReadPosition(t *testing.T) {
	db, repo := newDMReadDB(t)
	ctx := context.Background()

	var ids []string
	for i := 0; i < 10; i++ {
		ids = append(ids, send(t, repo, "friend", "m"))
	}

	// Simulate an 082-era row: a real read position, but no tie-break recorded.
	if _, err := db.Exec(`DELETE FROM dm_reads`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO dm_reads (user_id, dm_channel_id, last_read_message_id, last_read_at, last_read_seq)
		SELECT 'me', 'c1', id, created_at, 0 FROM dm_messages WHERE id = ?`, ids[2]); err != nil {
		t.Fatal(err)
	}

	sqlBytes, err := database.EmbeddedMigrations.ReadFile("migrations/083_dm_reads_seq.sql")
	if err != nil {
		t.Fatal(err)
	}
	// Skip the ALTER (already applied by the chain); run the repair + baseline.
	_, rest, ok := strings.Cut(string(sqlBytes), "last_read_seq INTEGER NOT NULL DEFAULT 0;")
	if !ok {
		t.Fatal("083 no longer contains the ALTER — this test is out of date")
	}
	if _, err := db.Exec(rest); err != nil {
		t.Fatalf("apply 083 repair+baseline: %v", err)
	}

	var got string
	if err := db.QueryRow(
		`SELECT last_read_message_id FROM dm_reads WHERE user_id='me' AND dm_channel_id='c1'`,
	).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != ids[2] {
		t.Errorf("the migration moved the read position from message 3 to %q — unread messages were silently marked read", got)
	}
	if n, _ := repo.CountUnread(ctx, "me", "c1"); n != 7 {
		t.Errorf("unread = %d, want 7 — the user had read 3 of 10", n)
	}
}
