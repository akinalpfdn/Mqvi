package services

import (
	"context"
	"database/sql"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/files"
)

type stubAppLog struct{}

func (stubAppLog) Log(models.LogLevel, models.LogCategory, *string, *string, string, map[string]string) {
}
func (stubAppLog) List(context.Context, models.AppLogFilter) ([]models.AppLog, int, error) {
	return nil, 0, nil
}
func (stubAppLog) Clear(context.Context) error { return nil }
func (stubAppLog) Start()                      {}
func (stubAppLog) Stop()                       {}

// A file the DB still points at, old enough that the grace window has passed.
// This is the exact state of every upload the day after it was made.
func agedFile(t *testing.T, uploadDir string, kind files.Kind, scopeID, name string) string {
	t.Helper()
	dir := filepath.Join(uploadDir, string(kind), scopeID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	old := time.Now().Add(-25 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
	return files.URLPathPrefix + "/" + string(kind) + "/" + scopeID + "/" + name
}

func orphanTestDB(t *testing.T) *sql.DB {
	t.Helper()
	migFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub migrations: %v", err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "orphan.db"), migFS)
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })

	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Conn.Exec(q, args...); err != nil {
			t.Fatalf("exec %q: %v", q, err)
		}
	}
	exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'owner', 'x')`)
	exec(`INSERT INTO servers (id, name, owner_id) VALUES ('s1', 'public server', 'u1')`)
	exec(`INSERT INTO server_reports (id, reporter_id, server_id, reason, description)
	      VALUES ('sr1', 'u1', 's1', 'spam', 'evidence attached')`)
	exec(`INSERT INTO voice_messages (id, channel_id, user_id) VALUES ('vm1', 'c1', 'u1')`)
	return db.Conn
}

func orphanWalker(db *sql.DB, uploadDir string) *cleanupService {
	return &cleanupService{
		db:          db,
		uploadDir:   uploadDir,
		fileDeleter: files.NewLocator(uploadDir, ""),
		appLog:      stubAppLog{},
	}
}

// The reported production bug. A server banner is uploaded, the DB records it in
// servers.banner_url — and the next nightly sweep deletes it off disk because the orphan
// walker's referenced-URL set never learned that column exists. The row survives, the file
// does not, and every request for it 404s from then on.
//
// The other two are the same omission on surfaces nobody has complained about yet: the
// evidence images on a server report (which an admin opens days later) and the attachments
// in a voice channel that has stayed occupied for over a day.
func TestOrphanWalk_DoesNotDeleteFilesTheDatabaseStillPointsAt(t *testing.T) {
	tests := []struct {
		name    string
		kind    files.Kind
		scopeID string
		link    func(t *testing.T, db *sql.DB, url string)
	}{
		{
			name: "server banner", kind: files.KindServerBanner, scopeID: "s1",
			link: func(t *testing.T, db *sql.DB, url string) {
				t.Helper()
				if _, err := db.Exec(`UPDATE servers SET banner_url = ? WHERE id = 's1'`, url); err != nil {
					t.Fatalf("link banner: %v", err)
				}
			},
		},
		{
			name: "server report evidence", kind: files.KindServerReport, scopeID: "sr1",
			link: func(t *testing.T, db *sql.DB, url string) {
				t.Helper()
				if _, err := db.Exec(
					`INSERT INTO server_report_attachments (id, server_report_id, filename, file_url)
					 VALUES ('sra1', 'sr1', 'evidence.png', ?)`, url); err != nil {
					t.Fatalf("link report attachment: %v", err)
				}
			},
		},
		{
			name: "voice message attachment", kind: files.KindVoiceMsg, scopeID: "c1",
			link: func(t *testing.T, db *sql.DB, url string) {
				t.Helper()
				if _, err := db.Exec(
					`INSERT INTO voice_message_attachments (id, voice_message_id, file_url, file_name, file_size)
					 VALUES ('vma1', 'vm1', ?, 'clip.png', 1)`, url); err != nil {
					t.Fatalf("link voice attachment: %v", err)
				}
			},
		},
		// Controls: these kinds are in the referenced set today and must stay there.
		{
			name: "user avatar", kind: files.KindAvatar, scopeID: "u1",
			link: func(t *testing.T, db *sql.DB, url string) {
				t.Helper()
				if _, err := db.Exec(`UPDATE users SET avatar_url = ? WHERE id = 'u1'`, url); err != nil {
					t.Fatalf("link avatar: %v", err)
				}
			},
		},
		{
			name: "server icon", kind: files.KindServerIcon, scopeID: "s1",
			link: func(t *testing.T, db *sql.DB, url string) {
				t.Helper()
				if _, err := db.Exec(`UPDATE servers SET icon_url = ? WHERE id = 's1'`, url); err != nil {
					t.Fatalf("link icon: %v", err)
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := orphanTestDB(t)
			uploadDir := t.TempDir()

			url := agedFile(t, uploadDir, tc.kind, tc.scopeID, "upload.png")
			tc.link(t, db, url)

			var st runStats
			orphanWalker(db, uploadDir).walkOrphans(context.Background(), &st)

			disk := filepath.Join(uploadDir, string(tc.kind), tc.scopeID, "upload.png")
			if _, err := os.Stat(disk); os.IsNotExist(err) {
				t.Fatalf("the sweep deleted a file the database still references (%s) — every request for it now 404s", url)
			}
		})
	}
}

// The other half: the walker must still do its job.
func TestOrphanWalk_DeletesAnUnreferencedFileOnceTheGraceWindowHasPassed(t *testing.T) {
	db := orphanTestDB(t)
	uploadDir := t.TempDir()

	agedFile(t, uploadDir, files.KindServerBanner, "s1", "nobody-points-at-me.png")

	var st runStats
	orphanWalker(db, uploadDir).walkOrphans(context.Background(), &st)

	disk := filepath.Join(uploadDir, string(files.KindServerBanner), "s1", "nobody-points-at-me.png")
	if _, err := os.Stat(disk); err == nil {
		t.Fatal("an orphan survived the sweep — the walker has stopped reclaiming disk")
	}
	if st.orphansDeleted != 1 {
		t.Errorf("orphansDeleted = %d, want 1", st.orphansDeleted)
	}
}

// The guard that makes the next one of these impossible. Adding an upload kind means writing
// a new directory of user files to disk; if nothing here tells the sweep those files are live,
// the sweep eats them. This test is what fails when someone forgets — it is the only thing
// standing between a new files.Kind and the bug that deleted every server banner.
func TestOrphanWalk_EveryUploadKindHasAReferenceSource(t *testing.T) {
	for _, kind := range files.AllKinds() {
		if len(defaultReferenceSources[kind]) == 0 {
			t.Errorf("upload kind %q writes files to disk but has no reference source — "+
				"the nightly sweep has no way to know they are live and will delete them", kind)
		}
	}
}

// notStoredFiles are the URL-shaped columns that do NOT hold a path to a file we wrote.
// Everything else the schema calls a URL must be registered as a reference source.
var notStoredFiles = map[string]string{
	"cleanup_failed_files.file_url": "the delete-retry queue itself — a row here means the file is on its way out, not live",
	"link_previews.url":             "remote page being previewed",
	"link_previews.image_url":       "remote Open Graph image",
	"link_previews.favicon_url":     "remote favicon",
	"livekit_instances.url":         "the SFU's address, not a file",
}

// The kind test above catches a new files.Kind. This catches the other shape: a new file
// column on a kind that IS registered (a second banner, a splash image). Migration 076 added
// servers.banner_url and this is the test that would have failed the day it landed.
//
// It is a naming heuristic, not a proof — a file column called something other than *_url
// slips past. Every file column in this schema follows that convention, plus badges.icon.
func TestOrphanWalk_EveryURLColumnInTheSchemaIsAccountedFor(t *testing.T) {
	db := orphanTestDB(t)

	rows, err := db.Query(`
		SELECT m.name, p.name FROM sqlite_master m
		JOIN pragma_table_info(m.name) p
		WHERE m.type = 'table' AND (p.name LIKE '%url%' OR p.name = 'icon')`)
	if err != nil {
		t.Fatalf("enumerate url columns: %v", err)
	}
	defer rows.Close()

	for rows.Next() {
		var table, column string
		if err := rows.Scan(&table, &column); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if _, known := notStoredFiles[table+"."+column]; known {
			continue
		}
		if !readByAnyReferenceSource(table, column) {
			t.Errorf("%s.%s looks like a stored file but no reference source reads it — "+
				"the nightly sweep will delete those files 24h after upload. Register it in "+
				"defaultReferenceSources, or add it to notStoredFiles with the reason.", table, column)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate: %v", err)
	}
}

func readByAnyReferenceSource(table, column string) bool {
	for _, queries := range defaultReferenceSources {
		for _, q := range queries {
			if strings.Contains(q, "FROM "+table+" ") && strings.Contains(q, column) {
				return true
			}
		}
	}
	return false
}

// A source that no longer matches the schema (renamed table, dropped column) aborts the whole
// walk. That fails safe, but it silently stops all disk reclamation until someone reads the
// logs. Catch it here instead.
func TestOrphanWalk_EveryReferenceQueryStillMatchesTheSchema(t *testing.T) {
	db := orphanTestDB(t)

	for _, kind := range files.AllKinds() {
		for _, q := range defaultReferenceSources[kind] {
			rows, err := db.Query(q)
			if err != nil {
				t.Errorf("reference source for %q no longer runs against the schema: %v\n  %s", kind, err, q)
				continue
			}
			rows.Close()
		}
	}
}

// The fail-safe itself, with teeth: a kind the walker cannot prove live is left on disk.
// Registration is what enables sweeping, so forgetting to register costs disk, not data.
func TestOrphanWalk_SkipsAKindItHasNoSourceFor(t *testing.T) {
	db := orphanTestDB(t)
	uploadDir := t.TempDir()

	agedFile(t, uploadDir, files.KindServerBanner, "s1", "unregistered.png")

	w := orphanWalker(db, uploadDir)
	w.refSources = map[files.Kind][]string{} // banner deliberately unregistered

	var st runStats
	w.walkOrphans(context.Background(), &st)

	disk := filepath.Join(uploadDir, string(files.KindServerBanner), "s1", "unregistered.png")
	if _, err := os.Stat(disk); os.IsNotExist(err) {
		t.Fatal("the sweep deleted files of a kind it had no source for — forgetting to register a kind must leak disk, not destroy user data")
	}
}

// A file uploaded minutes ago is not an orphan just because the row is not committed yet.
func TestOrphanWalk_LeavesAFreshUploadAlone(t *testing.T) {
	db := orphanTestDB(t)
	uploadDir := t.TempDir()

	dir := filepath.Join(uploadDir, string(files.KindServerBanner), "s1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	fresh := filepath.Join(dir, "just-uploaded.png")
	if err := os.WriteFile(fresh, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var st runStats
	orphanWalker(db, uploadDir).walkOrphans(context.Background(), &st)

	if _, err := os.Stat(fresh); os.IsNotExist(err) {
		t.Fatal("the sweep deleted an in-flight upload inside the grace window")
	}
}
