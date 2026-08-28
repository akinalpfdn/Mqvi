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
	// A clear naming a different instance must not touch the row: it is a late clear from a session
	// that already ended, and the row it would delete belongs to the call running right now.
	if err := repo.ClearChannelBinding(ctx, "chan1", "lk-old"); err != nil {
		t.Fatalf("stale clear: %v", err)
	}
	if got, err := repo.GetChannelBinding(ctx, "chan1"); err != nil || got != "lk1" {
		t.Fatalf("a stale clear erased a live binding: %q, %v", got, err)
	}

	if err := repo.ClearChannelBinding(ctx, "chan1", "lk1"); err != nil {
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

// seedInstance writes a platform instance directly, so a test can state its region and capacity
// without going through Create's id generation.
func seedInstance(t *testing.T, conn *sql.DB, id, region string, maxServers int) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO livekit_instances (id, url, api_key, api_secret, is_platform_managed, server_count, max_servers, hetzner_server_id, region)
		 VALUES (?, ?, 'k', 's', 1, 0, ?, '', ?)`,
		id, "wss://"+id+".test", maxServers, region,
	); err != nil {
		t.Fatalf("seed instance %s: %v", id, err)
	}
}

// loadInstance attaches n servers to an instance. Load is a live COUNT over the servers table, not
// the stored server_count column, so nothing but real rows moves it.
func loadInstance(t *testing.T, conn *sql.DB, instanceID string, n int) {
	t.Helper()
	if _, err := conn.Exec(`INSERT OR IGNORE INTO users (id, username, password_hash) VALUES ('u1', 'u1', 'x')`); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	for i := 0; i < n; i++ {
		if _, err := conn.Exec(
			`INSERT INTO servers (id, name, owner_id, livekit_instance_id) VALUES (?, 's', 'u1', ?)`,
			instanceID+"-srv-"+string(rune('a'+i)), instanceID,
		); err != nil {
			t.Fatalf("load %s: %v", instanceID, err)
		}
	}
}

// The whole point of the region column: a caller in North America must not be sent to Germany while
// an Ashburn instance sits there.
func TestLeastLoaded_PrefersTheCallersRegion(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "eu", models.RegionEUCentral, 0)
	seedInstance(t, conn, "us", models.RegionUSEast, 0)

	got, err := repo.GetPlatformInstanceForRegion(context.Background(), models.RegionUSEast)
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	if got.ID != "us" {
		t.Errorf("picked %q, want the us-east instance", got.ID)
	}
}

// Region wins over load, and it must: a nearer box carrying a few more calls still sounds better
// than a distant idle one. Without this the ordering would silently be load-first.
func TestLeastLoaded_RegionBeatsLoad(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "eu", models.RegionEUCentral, 0)
	seedInstance(t, conn, "us", models.RegionUSEast, 0)
	loadInstance(t, conn, "us", 5)

	got, err := repo.GetPlatformInstanceForRegion(context.Background(), models.RegionUSEast)
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	if got.ID != "us" {
		t.Errorf("picked %q — the emptier box in the wrong region won", got.ID)
	}
}

// No instance in the asked-for region is the normal state during a rollout: one region exists and
// everyone else must still be able to talk. The preference is an ORDER BY, never a filter.
func TestLeastLoaded_RegionWithNoInstanceStillYieldsOne(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "eu", models.RegionEUCentral, 0)

	got, err := repo.GetPlatformInstanceForRegion(context.Background(), models.RegionAPSoutheast)
	if err != nil {
		t.Fatalf("a caller in an unserved region could not be placed: %v", err)
	}
	if got.ID != "eu" {
		t.Errorf("picked %q, want the only instance", got.ID)
	}
}

// Capacity must never exile a caller from their own region. max_servers counts *registered
// servers*, which says nothing about how many people an SFU is carrying right now, so it is far too
// crude a signal to send somebody across an ocean with. A full instance next door still beats an
// empty one on another continent.
func TestForRegion_CapacityNeverExilesFromTheRegion(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "us", models.RegionUSEast, 2)
	loadInstance(t, conn, "us", 2) // at its cap
	seedInstance(t, conn, "eu", models.RegionEUCentral, 0)

	got, err := repo.GetPlatformInstanceForRegion(context.Background(), models.RegionUSEast)
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	if got.ID != "us" {
		t.Errorf("picked %q — a caller was sent out of their region over a server-count cap", got.ID)
	}
}

// Within one region capacity still counts, just as a preference rather than a gate: given a choice,
// don't pile onto the one that is already at its cap.
func TestForRegion_PrefersRoomWithinTheRegion(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "us-full", models.RegionUSEast, 1)
	loadInstance(t, conn, "us-full", 1) // at its cap, and the emptier of the two by server_count
	seedInstance(t, conn, "us-open", models.RegionUSEast, 0)
	loadInstance(t, conn, "us-open", 3)

	got, err := repo.GetPlatformInstanceForRegion(context.Background(), models.RegionUSEast)
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	if got.ID != "us-open" {
		t.Errorf("picked %q — room lost to raw load inside the region", got.ID)
	}
}

// Routing can never refuse over capacity. Registration still can, and must — that is the one
// question max_servers is actually denominated in.
func TestLeastLoaded_RegistrationStillRefusesWhenEverythingIsFull(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "us", models.RegionUSEast, 1)
	loadInstance(t, conn, "us", 1)

	if _, err := repo.GetLeastLoadedPlatformInstance(context.Background()); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("registration err = %v, want ErrNotFound — the server cap stopped applying", err)
	}
	if _, err := repo.GetPlatformInstanceForRegion(context.Background(), models.RegionUSEast); err != nil {
		t.Errorf("routing refused a call because an instance was at its server cap: %v", err)
	}
}

// Within one region, load decides. This is the pre-region behaviour and it must survive.
func TestLeastLoaded_TieBreaksOnLoadWithinARegion(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "us1", models.RegionUSEast, 0)
	seedInstance(t, conn, "us2", models.RegionUSEast, 0)
	loadInstance(t, conn, "us1", 3)

	got, err := repo.GetPlatformInstanceForRegion(context.Background(), models.RegionUSEast)
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	if got.ID != "us2" {
		t.Errorf("picked %q, want the emptier one in the same region", got.ID)
	}
}

// An empty preference must behave exactly as it did before regions existed — plain least-loaded —
// because two callers still pass "" and a background sweep has no region at all.
func TestLeastLoaded_NoPreferenceIsPlainLeastLoaded(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "eu", models.RegionEUCentral, 0)
	loadInstance(t, conn, "eu", 4)
	seedInstance(t, conn, "us", models.RegionUSEast, 0)

	got, err := repo.GetPlatformInstanceForRegion(context.Background(), "")
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	if got.ID != "us" {
		t.Errorf("picked %q, want the emptier one", got.ID)
	}
}

// An unknown region is stored as the empty string, and it must not accidentally match a caller who
// also has no preference in a way that outranks load.
func TestLeastLoaded_UnknownRegionRowDoesNotOutrankLoad(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "legacy", models.RegionUnknown, 0)
	loadInstance(t, conn, "legacy", 4)
	seedInstance(t, conn, "us", models.RegionUSEast, 0)

	got, err := repo.GetPlatformInstanceForRegion(context.Background(), "")
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	if got.ID != "us" {
		t.Errorf("picked %q — a regionless row matched an empty preference and beat load", got.ID)
	}
}

func TestLeastLoaded_NoInstanceAtAllIsNotFound(t *testing.T) {
	_, repo := newLiveKitDB(t)

	_, err := repo.GetPlatformInstanceForRegion(context.Background(), models.RegionUSEast)
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

// GetByServerID had no test and shipped broken: the region column was added to its Scan but not to
// its SELECT, so every call returned "expected 9 destination arguments in Scan, not 10". It is the
// only way pickInstance reaches a server's own instance, which means every voice join on a channel
// with no binding failed — every first join, and every join after a restart. It compiled, vetted,
// and the whole suite stayed green because the service tests use a stub getter.
func TestLiveKitRepo_GetByServerIDReturnsTheInstanceWithItsRegion(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	seedInstance(t, conn, "lk1", models.RegionUSEast, 0)
	loadInstance(t, conn, "lk1", 1) // also creates the server row that points at it

	inst, err := repo.GetByServerID(context.Background(), "lk1-srv-a")
	if err != nil {
		t.Fatalf("GetByServerID: %v", err)
	}
	if inst.ID != "lk1" {
		t.Errorf("got instance %q, want lk1", inst.ID)
	}
	if inst.Region != models.RegionUSEast {
		t.Errorf("region = %q, want %q — the column is scanned but not selected", inst.Region, models.RegionUSEast)
	}
	if inst.ServerCount != 1 {
		t.Errorf("server_count = %d, want 1", inst.ServerCount)
	}
}

func TestLiveKitRepo_GetByServerIDIsNotFoundForAnUnknownServer(t *testing.T) {
	_, repo := newLiveKitDB(t)

	if _, err := repo.GetByServerID(context.Background(), "nope"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

// Deleting an instance is gated on live calls, not on registered servers. Since placement became
// per-channel and by region the two are unrelated: a freshly added region carries calls with no
// servers registered against it, which is also what makes it the most attractive target.
func TestLiveKitRepo_CountChannelBindingsSeesCallsWithNoServers(t *testing.T) {
	conn, repo := newLiveKitDB(t)
	ctx := context.Background()
	seedInstance(t, conn, "lk-new-region", models.RegionUSEast, 0) // zero servers registered
	seedChannelForBinding(t, conn, "chanA")
	seedChannelForBinding(t, conn, "chanB")

	if n, err := repo.CountChannelBindings(ctx, "lk-new-region"); err != nil || n != 0 {
		t.Fatalf("empty instance: %d, %v", n, err)
	}

	for _, ch := range []string{"chanA", "chanB"} {
		if err := repo.SetChannelBinding(ctx, ch, "lk-new-region"); err != nil {
			t.Fatalf("bind %s: %v", ch, err)
		}
	}

	n, err := repo.CountChannelBindings(ctx, "lk-new-region")
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Errorf("counted %d live calls, want 2 — an instance with no servers looked idle", n)
	}

	if err := repo.ClearChannelBinding(ctx, "chanA", "lk-new-region"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if n, err := repo.CountChannelBindings(ctx, "lk-new-region"); err != nil || n != 1 {
		t.Errorf("after one call ended: %d, %v", n, err)
	}
}
