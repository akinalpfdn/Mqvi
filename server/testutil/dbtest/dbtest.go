// Package dbtest stands up a real database for tests.
//
// It applies the embedded migrations the server applies at boot, so a test runs against the schema
// production runs against. Hand-written CREATE TABLE blocks were the alternative, and they test a
// schema that exists only inside the test file — a column added, renamed or dropped by a migration
// leaves them passing on a table nothing else has.
//
// Kept out of testutil itself: that package implements repository interfaces and therefore imports
// repository, which would be an import cycle for repository's own tests. This one imports nothing
// above the database and model layers.
package dbtest

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/akinalp/mqvi/database"

	_ "modernc.org/sqlite"
)

var (
	templateOnce  sync.Once
	templateBytes []byte
	templateErr   error
)

// migratedTemplate is the byte image of a fully migrated database, built once per test binary.
//
// Applying every migration per fixture cost ~7.5s each under -race, which is most of what the
// repository suite spent. Migrating once and stamping out copies keeps each fixture on the real
// schema for a file write. Held as bytes rather than a temp file so nothing is left on disk.
func migratedTemplate() ([]byte, error) {
	templateOnce.Do(func() {
		dir, err := os.MkdirTemp("", "dbtest-template")
		if err != nil {
			templateErr = fmt.Errorf("temp dir: %w", err)
			return
		}
		defer func() { _ = os.RemoveAll(dir) }()

		migFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
		if err != nil {
			templateErr = fmt.Errorf("read embedded migrations: %w", err)
			return
		}
		path := filepath.Join(dir, "template.db")
		db, err := database.New(path, migFS)
		if err != nil {
			templateErr = fmt.Errorf("apply migrations: %w", err)
			return
		}
		// Fold the WAL back into the main file, or the copy would be a database missing every write
		// the migrations just made.
		if _, err := db.Conn.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
			_ = db.Conn.Close()
			templateErr = fmt.Errorf("checkpoint: %w", err)
			return
		}
		if err := db.Conn.Close(); err != nil {
			templateErr = fmt.Errorf("close template: %w", err)
			return
		}
		templateBytes, err = os.ReadFile(path)
		if err != nil {
			templateErr = fmt.Errorf("read template: %w", err)
		}
	})
	return templateBytes, templateErr
}

// Fixture is a migrated database plus seeders for the rows most tests need before they can say
// anything. Every seeder fails the test on error — a broken fixture is not a test result.
type Fixture struct {
	t  *testing.T
	DB *sql.DB
	n  int
}

// New returns a fixture backed by a fully migrated database in the test's temp dir.
//
// The database is stamped from the migrated template, then reopened through database.New so the
// connection carries exactly the pragmas production uses. Migrations are already recorded in the
// copy, so that second call applies nothing.
func New(t *testing.T) *Fixture {
	t.Helper()

	template, err := migratedTemplate()
	if err != nil {
		t.Fatalf("dbtest: build template: %v", err)
	}

	migFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("dbtest: read embedded migrations: %v", err)
	}
	path := filepath.Join(t.TempDir(), "test.db")
	if err := os.WriteFile(path, template, 0o600); err != nil {
		t.Fatalf("dbtest: stamp template: %v", err)
	}
	db, err := database.New(path, migFS)
	if err != nil {
		t.Fatalf("dbtest: open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })

	return &Fixture{t: t, DB: db.Conn}
}

// exec runs a statement and fails the test with the statement in the message, so a broken fixture
// points at itself instead of surfacing three assertions later.
func (f *Fixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.DB.Exec(query, args...); err != nil {
		f.t.Fatalf("dbtest: %v\n  query: %s", err, query)
	}
}

// nextID hands out ids that are unique within a test without the caller inventing them.
func (f *Fixture) nextID(prefix string) string {
	f.n++
	return fmt.Sprintf("%s%d", prefix, f.n)
}

// User seeds a user. Pass an empty id to have one generated.
func (f *Fixture) User(id string) string {
	f.t.Helper()
	if id == "" {
		id = f.nextID("u")
	}
	f.exec(
		`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`,
		id, "user_"+id,
	)
	return id
}

// ServerSeed is what a test may vary about a server. Everything else takes a default.
type ServerSeed struct {
	ID          string
	OwnerID     string
	Name        string
	E2EEEnabled bool
}

// Server seeds a server, creating an owner if the seed does not name one.
func (f *Fixture) Server(seed ServerSeed) string {
	f.t.Helper()
	if seed.ID == "" {
		seed.ID = f.nextID("s")
	}
	if seed.OwnerID == "" {
		seed.OwnerID = f.User("")
	}
	if seed.Name == "" {
		seed.Name = "Server " + seed.ID
	}
	f.exec(
		`INSERT INTO servers (id, name, owner_id, e2ee_enabled) VALUES (?, ?, ?, ?)`,
		seed.ID, seed.Name, seed.OwnerID, seed.E2EEEnabled,
	)
	return seed.ID
}

// Channel seeds a text channel, creating a server if none is named.
func (f *Fixture) Channel(id, serverID string) string {
	f.t.Helper()
	if id == "" {
		id = f.nextID("c")
	}
	if serverID == "" {
		serverID = f.Server(ServerSeed{})
	}
	f.exec(
		`INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, 'text')`,
		id, serverID, "channel-"+id,
	)
	return id
}

// MessageSeed carries the fields message tests actually vary. A zero EncryptionVersion with a
// Content is a plaintext message; version 1 with a Ciphertext is an encrypted one.
type MessageSeed struct {
	ID                string
	ChannelID         string
	UserID            string
	Content           *string
	EncryptionVersion int
	Ciphertext        *string
	SenderDeviceID    *string
}

// Message seeds a channel message, creating the channel and author if the seed omits them.
func (f *Fixture) Message(seed MessageSeed) string {
	f.t.Helper()
	if seed.ID == "" {
		seed.ID = f.nextID("m")
	}
	if seed.ChannelID == "" {
		seed.ChannelID = f.Channel("", "")
	}
	if seed.UserID == "" {
		seed.UserID = f.User("")
	}
	f.exec(
		`INSERT INTO messages (id, channel_id, user_id, content, encryption_version, ciphertext, sender_device_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		seed.ID, seed.ChannelID, seed.UserID, seed.Content,
		seed.EncryptionVersion, seed.Ciphertext, seed.SenderDeviceID,
	)
	return seed.ID
}

// DMChannel seeds a conversation between two users, creating them if not named.
func (f *Fixture) DMChannel(id, user1ID, user2ID string) string {
	f.t.Helper()
	if id == "" {
		id = f.nextID("dc")
	}
	if user1ID == "" {
		user1ID = f.User("")
	}
	if user2ID == "" {
		user2ID = f.User("")
	}
	f.exec(
		`INSERT INTO dm_channels (id, user1_id, user2_id) VALUES (?, ?, ?)`,
		id, user1ID, user2ID,
	)
	return id
}

// DMMessageSeed mirrors MessageSeed for direct messages.
type DMMessageSeed struct {
	ID                string
	DMChannelID       string
	UserID            string
	Content           *string
	EncryptionVersion int
	Ciphertext        *string
	SenderDeviceID    *string
}

// DMMessage seeds a direct message, creating the conversation and author if the seed omits them.
func (f *Fixture) DMMessage(seed DMMessageSeed) string {
	f.t.Helper()
	if seed.ID == "" {
		seed.ID = f.nextID("dm")
	}
	if seed.DMChannelID == "" {
		seed.DMChannelID = f.DMChannel("", "", "")
	}
	if seed.UserID == "" {
		var u string
		if err := f.DB.QueryRow(
			`SELECT user1_id FROM dm_channels WHERE id = ?`, seed.DMChannelID,
		).Scan(&u); err != nil {
			f.t.Fatalf("dbtest: resolve DM author: %v", err)
		}
		seed.UserID = u
	}
	f.exec(
		`INSERT INTO dm_messages (id, dm_channel_id, user_id, content, encryption_version, ciphertext, sender_device_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		seed.ID, seed.DMChannelID, seed.UserID, seed.Content,
		seed.EncryptionVersion, seed.Ciphertext, seed.SenderDeviceID,
	)
	return seed.ID
}

// ExecWithoutForeignKeys runs a statement with foreign keys off.
//
// For the rare test that has to build a state the schema forbids — a dangling reference left by an
// older release, say — to prove a query is defensive about it. It takes a dedicated connection
// because the pragma is per-connection and the pool hands out several.
func (f *Fixture) ExecWithoutForeignKeys(query string, args ...any) {
	f.t.Helper()
	ctx := context.Background()
	conn, err := f.DB.Conn(ctx)
	if err != nil {
		f.t.Fatalf("dbtest: take connection: %v", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		f.t.Fatalf("dbtest: disable foreign keys: %v", err)
	}
	_, execErr := conn.ExecContext(ctx, query, args...)
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys=ON`); err != nil {
		f.t.Fatalf("dbtest: restore foreign keys: %v", err)
	}
	if execErr != nil {
		f.t.Fatalf("dbtest: %v\n  query: %s", execErr, query)
	}
}

// Ptr is the shorthand for the optional string columns the seeds take.
func Ptr[T any](v T) *T { return &v }
