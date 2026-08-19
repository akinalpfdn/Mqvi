package repository

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	_ "modernc.org/sqlite"
)

// Against the real migration chain, because the thing most likely to break here is the SQL itself.
// Every one of these queries names its columns by hand — adding one means editing an INSERT, four
// SELECT lists, four Scans and an UPDATE, and a miscount compiles perfectly and fails at runtime.
// Nothing exercised them before this file.
func newLiveKitDB(t *testing.T) (*sql.DB, *sqliteLiveKitRepo) {
	t.Helper()
	migFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("sub migrations: %v", err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "lk.db"), migFS)
	if err != nil {
		t.Fatalf("migrations: %v", err)
	}
	t.Cleanup(func() { _ = db.Conn.Close() })
	return db.Conn, &sqliteLiveKitRepo{db: db.Conn}
}

func TestLiveKitRepo_CreateGetUpdateRoundTrip(t *testing.T) {
	_, repo := newLiveKitDB(t)
	ctx := context.Background()

	inst := &models.LiveKitInstance{
		URL: "wss://lk1.test", APIKey: "k", APISecret: "s",
		IsPlatformManaged: true, MaxServers: 10, HetznerServerID: "h1",
		Region: models.RegionEUCentral,
	}
	if err := repo.Create(ctx, inst); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.GetByID(ctx, inst.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Region != models.RegionEUCentral {
		t.Errorf("region = %q, want %q — the column is written but not read back", got.Region, models.RegionEUCentral)
	}
	if got.URL != inst.URL || got.MaxServers != 10 || got.HetznerServerID != "h1" {
		t.Errorf("round trip lost fields: %+v", got)
	}

	got.Region = models.RegionUSEast
	got.MaxServers = 20
	if err := repo.Update(ctx, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	after, err := repo.GetByID(ctx, inst.ID)
	if err != nil {
		t.Fatalf("get after update: %v", err)
	}
	if after.Region != models.RegionUSEast || after.MaxServers != 20 {
		t.Errorf("update did not stick: region=%q max=%d", after.Region, after.MaxServers)
	}
}

// Every instance that predates the region column reads back as unknown, and unknown must remain a
// usable instance rather than one that quietly serves nobody.
func TestLiveKitRepo_PreExistingInstanceHasUnknownRegion(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	ctx := context.Background()

	// Written the way a pre-migration row was: no region at all.
	if _, err := conn.Exec(
		`INSERT INTO livekit_instances (id, url, api_key, api_secret, is_platform_managed, server_count, max_servers, hetzner_server_id)
		 VALUES ('old', 'wss://old.test', 'k', 's', 1, 0, 0, '')`,
	); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}

	got, err := repo.GetByID(ctx, "old")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Region != models.RegionUnknown {
		t.Errorf("region = %q, want empty", got.Region)
	}

	least, err := repo.GetLeastLoadedPlatformInstance(ctx)
	if err != nil {
		t.Fatalf("an instance with no region became unselectable: %v", err)
	}
	if least.ID != "old" {
		t.Errorf("picked %q, want the only instance", least.ID)
	}
}

func TestLiveKitRepo_ChannelBindingRoundTrip(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	ctx := context.Background()

	if _, err := conn.Exec(
		`INSERT INTO livekit_instances (id, url, api_key, api_secret, is_platform_managed, server_count, max_servers, hetzner_server_id, region)
		 VALUES ('lk1', 'wss://lk1.test', 'k', 's', 1, 0, 0, '', 'eu-central')`,
	); err != nil {
		t.Fatalf("seed instance: %v", err)
	}
	seedChannelForBinding(t, conn, "chan1")

	if _, err := repo.GetChannelBinding(ctx, "chan1"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("unbound channel: got %v, want ErrNotFound", err)
	}
	if err := repo.SetChannelBinding(ctx, "chan1", "lk1"); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := repo.GetChannelBinding(ctx, "chan1")
	if err != nil || got != "lk1" {
		t.Fatalf("get: %q, %v", got, err)
	}
	// A restart re-adopting a binding it already holds must not fail on the primary key.
	if err := repo.SetChannelBinding(ctx, "chan1", "lk1"); err != nil {
		t.Fatalf("re-set: %v", err)
	}
	if err := repo.ClearChannelBinding(ctx, "chan1"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, err := repo.GetChannelBinding(ctx, "chan1"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("after clear: got %v, want ErrNotFound", err)
	}
}

// The binding row has a foreign key to channels, so it needs a real channel to point at.
func seedChannelForBinding(t *testing.T, conn *sql.DB, channelID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO channels (id, name, type) VALUES (?, 'general', 'voice')`, channelID,
	); err != nil {
		t.Fatalf("seed channel %s: %v", channelID, err)
	}
}
