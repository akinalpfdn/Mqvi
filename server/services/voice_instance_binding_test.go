package services

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/testutil"
)

// A getter that hands out a DIFFERENT instance every time it is asked to pick.
//
// With one real platform instance every path returns the same answer, so a test built on the real
// shape would pass whether the binding worked or not. Handing out a fresh id per call is what makes
// "everyone ended up in the same room" a claim the test can actually falsify.
type uniqueInstanceGetter struct {
	picks     atomic.Int64
	byIDCalls atomic.Int64
	apiKey    string
	apiSecret string
}

func (g *uniqueInstanceGetter) GetByServerID(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	n := g.picks.Add(1)
	return g.instance(fmt.Sprintf("lk-%d", n)), nil
}

// Returns a stable instance per region so a test can assert "this joiner was placed in eu-north"
// rather than merely "somewhere". An empty preference behaves like the plain least-loaded pick.
//
// The returned instance carries the region on the struct, not just in its id. The real query orders
// by region without filtering, so it can hand back an instance from somewhere else entirely, and
// the caller checks the field before moving a call there. A fake that left Region empty would make
// that check untestable.
func (g *uniqueInstanceGetter) GetPlatformInstanceForRegion(_ context.Context, region string) (*models.LiveKitInstance, error) {
	if region == "" {
		return g.instance("lk-least-loaded"), nil
	}
	inst := g.instance("lk-" + region)
	inst.Region = region
	return inst, nil
}

// mismatchedRegionGetter answers every region request with an instance that is somewhere else —
// exactly what the ordering-not-filtering query does when no instance carries the asked-for region,
// which is the state of every deployment until an operator sets one.
type mismatchedRegionGetter struct {
	uniqueInstanceGetter
	elsewhere string
}

func (g *mismatchedRegionGetter) GetPlatformInstanceForRegion(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	inst := g.instance("lk-far-away")
	inst.Region = g.elsewhere
	return inst, nil
}

func (g *uniqueInstanceGetter) GetByID(_ context.Context, id string) (*models.LiveKitInstance, error) {
	g.byIDCalls.Add(1)
	return g.instance(id), nil
}

func (g *uniqueInstanceGetter) instance(id string) *models.LiveKitInstance {
	return &models.LiveKitInstance{
		ID: id, URL: "wss://" + id + ".test", APIKey: g.apiKey, APISecret: g.apiSecret,
		IsPlatformManaged: true,
	}
}

func bindingHarness(t *testing.T) (*voiceService, *uniqueInstanceGetter) {
	t.Helper()
	key := make([]byte, 32) // all-zero AES-256 key; only decryptability matters
	apiKey, err := crypto.Encrypt("devkey", key)
	if err != nil {
		t.Fatalf("encrypt api key: %v", err)
	}
	apiSecret, err := crypto.Encrypt("devsecret", key)
	if err != nil {
		t.Fatalf("encrypt api secret: %v", err)
	}
	getter := &uniqueInstanceGetter{apiKey: apiKey, apiSecret: apiSecret}
	// Built through the real constructor rather than a struct literal. A hand-built service silently
	// misses every field added later — this harness went nil on pendingJoins the moment that map was
	// introduced, and a test that constructs the service differently from production is testing a
	// different object. nil dependencies are fine: nothing these tests exercise reaches them.
	svc := NewVoiceService(
		nil, // channelGetter
		getter,
		nil, // bindingStore: in-memory only unless a test sets one
		nil, // permResolver
		nil, // hub
		nil, // onlineChecker
		nil, // afkTimeoutGetter
		key,
		nil, // urlSigner
	).(*voiceService)
	return svc, getter
}

func TestResolveRoomInstance_SecondCallFollowsTheFirst(t *testing.T) {
	s, getter := bindingHarness(t)
	ctx := context.Background()

	first, err := s.resolveRoomInstance(ctx, "srv1", "chan1")
	if err != nil {
		t.Fatalf("first resolve: %v", err)
	}
	second, err := s.resolveRoomInstance(ctx, "srv1", "chan1")
	if err != nil {
		t.Fatalf("second resolve: %v", err)
	}

	if first.InstanceID != second.InstanceID {
		t.Fatalf("channel moved instances between calls: %s then %s", first.InstanceID, second.InstanceID)
	}
	// Only the first request may choose; anything else means the binding was not consulted.
	if n := getter.picks.Load(); n != 1 {
		t.Errorf("picked %d times, want 1 — the binding is being ignored", n)
	}
}

// The one that matters. A token is minted from an HTTP handler and the voice state is only updated
// later over the websocket, so two people joining an empty channel at the same instant cannot see
// each other. If the claim is not atomic they each open a room of the same name on a different SFU:
// both work, neither hears the other, and nothing errors.
func TestResolveRoomInstance_ConcurrentJoinersLandInOneRoom(t *testing.T) {
	s, _ := bindingHarness(t)
	ctx := context.Background()

	const joiners = 32
	results := make([]string, joiners)
	var wg sync.WaitGroup
	start := make(chan struct{})

	for i := 0; i < joiners; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start // release them together to make the interleaving likely
			room, err := s.resolveRoomInstance(ctx, "srv1", "chan1")
			if err != nil {
				t.Errorf("joiner %d: %v", idx, err)
				return
			}
			results[idx] = room.InstanceID
		}(i)
	}
	close(start)
	wg.Wait()

	for i, got := range results {
		if got != results[0] {
			t.Fatalf("joiner %d landed on %s, joiner 0 on %s — the channel split across instances", i, got, results[0])
		}
	}
	if len(s.channelInstances) != 1 {
		t.Errorf("bindings: %v, want exactly one", s.channelInstances)
	}
}

func TestResolveRoomInstance_DifferentChannelsBindIndependently(t *testing.T) {
	s, _ := bindingHarness(t)
	ctx := context.Background()

	a, _ := s.resolveRoomInstance(ctx, "srv1", "chan1")
	b, _ := s.resolveRoomInstance(ctx, "srv1", "chan2")

	if a.InstanceID == b.InstanceID {
		t.Fatalf("both channels claimed %s — the binding is keyed too coarsely", a.InstanceID)
	}
}

// A binding that outlived its room would pin the next session to a choice made for people who have
// all left — and after GEO-05 that means routing a new group to someone else's region.
func TestCleanupRoomPassphraseIfEmpty_ReleasesTheBinding(t *testing.T) {
	s, _ := bindingHarness(t)
	ctx := context.Background()

	before, _ := s.resolveRoomInstance(ctx, "srv1", "chan1")

	s.mu.Lock()
	s.cleanupRoomPassphraseIfEmpty("chan1") // no states -> channel is empty
	s.mu.Unlock()

	if len(s.channelInstances) != 0 {
		t.Fatalf("binding survived an empty channel: %v", s.channelInstances)
	}
	after, _ := s.resolveRoomInstance(ctx, "srv1", "chan1")
	if after.InstanceID == before.InstanceID {
		t.Errorf("re-used %s after release — the next session should choose afresh", after.InstanceID)
	}
}

// Someone still in the channel must not have the room moved out from under them.
func TestCleanupRoomPassphraseIfEmpty_KeepsTheBindingWhileOccupied(t *testing.T) {
	s, _ := bindingHarness(t)
	ctx := context.Background()

	before, _ := s.resolveRoomInstance(ctx, "srv1", "chan1")
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "chan1"}

	s.mu.Lock()
	s.cleanupRoomPassphraseIfEmpty("chan1")
	s.mu.Unlock()

	after, _ := s.resolveRoomInstance(ctx, "srv1", "chan1")
	if after.InstanceID != before.InstanceID {
		t.Fatalf("occupied channel moved from %s to %s", before.InstanceID, after.InstanceID)
	}
}

// Migration used to split live calls: the row changed and new joiners went to the new instance
// while everyone already connected stayed on the old one. Nothing detected it, because the room
// name is the same on both. The channel binding fixes this without any migration-specific code —
// an occupied channel keeps the instance it claimed, and only picks up the server's new default
// once it empties. This test is what says that is true rather than hoped.
func TestChannelBinding_SurvivesTheServerMovingInstances(t *testing.T) {
	s, getter := bindingHarness(t)
	ctx := context.Background()

	// Someone is in the channel, so the channel is bound and occupied.
	before, err := s.resolveRoomInstance(ctx, "srv1", "chan1")
	if err != nil {
		t.Fatalf("initial resolve: %v", err)
	}
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "chan1"}

	// The admin moves the server. The getter now hands out a different instance for srv1, which is
	// exactly what a migrated server looks like from here.
	picksBefore := getter.picks.Load()

	// A second person joins the occupied channel.
	joiner, err := s.resolveRoomInstance(ctx, "srv1", "chan1")
	if err != nil {
		t.Fatalf("joiner resolve: %v", err)
	}
	if joiner.InstanceID != before.InstanceID {
		t.Fatalf("joiner went to %s while the call is on %s — the migration split the room",
			joiner.InstanceID, before.InstanceID)
	}
	if got := getter.picks.Load(); got != picksBefore {
		t.Errorf("the server default was consulted for an occupied channel (%d new picks)", got-picksBefore)
	}

	// Everyone leaves; only now may the channel adopt the server's new instance.
	delete(s.states, "u1")
	s.mu.Lock()
	s.cleanupRoomPassphraseIfEmpty("chan1")
	s.mu.Unlock()

	after, err := s.resolveRoomInstance(ctx, "srv1", "chan1")
	if err != nil {
		t.Fatalf("post-empty resolve: %v", err)
	}
	if after.InstanceID == before.InstanceID {
		t.Errorf("still on %s after emptying — the migration never took effect", after.InstanceID)
	}
}

// ── Restart recovery ───────────────────────────────────────────────────────────────────────────
//
// A restart clears the in-memory binding while the clients stay connected to the SFU — the process
// forgets where a call is happening, but the call is still happening. Picking afresh would send the
// next joiner elsewhere and split it, and nothing would report that: the room name is identical on
// both instances, so both halves work and neither hears the other.

type fakeBindingStore struct {
	mu      sync.Mutex
	rows    map[string]string
	cleared chan string
	getErr  error
	setErr  error
}

func newFakeBindingStore() *fakeBindingStore {
	return &fakeBindingStore{rows: map[string]string{}, cleared: make(chan string, 8)}
}

func (f *fakeBindingStore) GetChannelBinding(_ context.Context, channelID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return "", f.getErr
	}
	id, ok := f.rows[channelID]
	if !ok {
		return "", pkg.ErrNotFound
	}
	return id, nil
}

func (f *fakeBindingStore) SetChannelBinding(_ context.Context, channelID, instanceID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.setErr != nil {
		return f.setErr
	}
	f.rows[channelID] = instanceID
	return nil
}

// Mirrors the real conditional delete: only removes the row if it still names instanceID, so a
// clear that arrives after a fresh claim leaves the new binding alone.
func (f *fakeBindingStore) ClearChannelBinding(_ context.Context, channelID, instanceID string) error {
	f.mu.Lock()
	if f.rows[channelID] == instanceID {
		delete(f.rows, channelID)
	}
	f.mu.Unlock()
	f.cleared <- channelID
	return nil
}

func (f *fakeBindingStore) get(channelID string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id, ok := f.rows[channelID]
	return id, ok
}

func TestResolveRoomInstance_AdoptsAStoredBindingAfterRestart(t *testing.T) {
	s, getter := bindingHarness(t)
	store := newFakeBindingStore()
	s.bindingStore = store
	ctx := context.Background()

	// A call is in progress on lk-live; the process then forgets everything but the row.
	store.rows["chan1"] = "lk-live"
	picksBefore := getter.picks.Load()

	room, err := s.resolveRoomInstance(ctx, "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	if room.InstanceID != "lk-live" {
		t.Fatalf("joined %s while the call is on lk-live — the restart split the room", room.InstanceID)
	}
	if got := getter.picks.Load(); got != picksBefore {
		t.Errorf("chose a new instance despite a live binding (%d picks)", got-picksBefore)
	}
}

func TestResolveRoomInstance_PersistsTheClaim(t *testing.T) {
	s, _ := bindingHarness(t)
	store := newFakeBindingStore()
	s.bindingStore = store

	room, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	// Without this row the next restart has nothing to recover from.
	got, ok := store.get("chan1")
	if !ok || got != room.InstanceID {
		t.Fatalf("stored %q (present=%v), want %q", got, ok, room.InstanceID)
	}
}

func TestReleaseChannelInstance_ClearsTheStoredRow(t *testing.T) {
	s, _ := bindingHarness(t)
	store := newFakeBindingStore()
	s.bindingStore = store
	ctx := context.Background()

	if _, err := s.resolveRoomInstance(ctx, "srv1", "chan1"); err != nil {
		t.Fatalf("resolve: %v", err)
	}

	s.mu.Lock()
	s.cleanupRoomPassphraseIfEmpty("chan1")
	s.mu.Unlock()

	select {
	case <-store.cleared:
	case <-time.After(2 * time.Second):
		t.Fatal("the row was never cleared — a dead call would be recovered after the next restart")
	}
	if _, ok := store.get("chan1"); ok {
		t.Error("row still present after clear")
	}
}

// The row can name an instance that has since been deleted. Refusing the join would make the
// channel permanently unusable; choosing again is the only sane answer.
func TestResolveRoomInstance_RebindsWhenTheStoredInstanceIsGone(t *testing.T) {
	s, _ := bindingHarness(t)
	store := newFakeBindingStore()
	store.rows["chan1"] = "lk-deleted"
	s.bindingStore = store
	s.livekitGetter = &missingInstanceGetter{uniqueInstanceGetter: uniqueInstanceGetter{
		apiKey: s.encryptionKeyFixture(t, "devkey"), apiSecret: s.encryptionKeyFixture(t, "devsecret"),
	}, missing: "lk-deleted"}

	room, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve should have rebound, got: %v", err)
	}
	if room.InstanceID == "lk-deleted" {
		t.Fatal("still bound to the deleted instance")
	}
}

// A store that is unavailable must not stop people talking: memory stays authoritative and only
// restart recovery degrades.
func TestResolveRoomInstance_JoinStillWorksWhenTheStoreFails(t *testing.T) {
	s, _ := bindingHarness(t)
	store := newFakeBindingStore()
	store.getErr = fmt.Errorf("database is down")
	store.setErr = fmt.Errorf("database is down")
	s.bindingStore = store

	first, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("join refused because the store failed: %v", err)
	}
	second, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("second resolve: %v", err)
	}
	if first.InstanceID != second.InstanceID {
		t.Errorf("in-memory binding lost when the store failed: %s then %s", first.InstanceID, second.InstanceID)
	}
}

type missingInstanceGetter struct {
	uniqueInstanceGetter
	missing string
}

func (g *missingInstanceGetter) GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error) {
	if id == g.missing {
		return nil, pkg.ErrNotFound
	}
	return g.uniqueInstanceGetter.GetByID(ctx, id)
}

func (s *voiceService) encryptionKeyFixture(t *testing.T, plain string) string {
	t.Helper()
	enc, err := crypto.Encrypt(plain, s.encryptionKey)
	if err != nil {
		t.Fatalf("encrypt %s: %v", plain, err)
	}
	return enc
}

// ── Region-aware placement ─────────────────────────────────────────────────────────────────────

func withRegion(region string) context.Context {
	return context.WithValue(context.Background(), ctxkeys.ClientRegion, region)
}

func TestPickInstance_PlacesTheCallInTheJoinersRegion(t *testing.T) {
	s, _ := bindingHarness(t)

	room, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if room.InstanceID != "lk-"+models.RegionUSEast {
		t.Errorf("placed on %s, want the us-east instance", room.InstanceID)
	}
}

// No signal must mean no change: this is the behaviour every call had before regions existed, and
// it is what a background sweep with no request behind it gets.
func TestPickInstance_UnknownRegionUsesTheServerDefault(t *testing.T) {
	s, getter := bindingHarness(t)

	room, err := s.resolveRoomInstance(withRegion(models.RegionUnknown), "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// GetByServerID hands out lk-1, lk-2…; the region-aware path would have returned lk-<region>.
	if room.InstanceID != "lk-1" {
		t.Errorf("placed on %s, want the server default", room.InstanceID)
	}
	if n := getter.picks.Load(); n != 1 {
		t.Errorf("server default consulted %d times, want 1", n)
	}
}

func TestPickInstance_NoContextRegionUsesTheServerDefault(t *testing.T) {
	s, _ := bindingHarness(t)

	room, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if room.InstanceID != "lk-1" {
		t.Errorf("placed on %s, want the server default", room.InstanceID)
	}
}

// A self-hosted server owns its LiveKit. Moving such a call onto platform hardware would be wrong
// and a surprise to whoever runs it — the region must be ignored entirely.
func TestPickInstance_NeverMovesASelfHostedServer(t *testing.T) {
	s, _ := bindingHarness(t)
	s.livekitGetter = &selfHostedGetter{uniqueInstanceGetter: uniqueInstanceGetter{
		apiKey: s.encryptionKeyFixture(t, "devkey"), apiSecret: s.encryptionKeyFixture(t, "devsecret"),
	}}

	room, err := s.resolveRoomInstance(withRegion(models.RegionAPSoutheast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if room.InstanceID != "lk-self-hosted" {
		t.Fatalf("a self-hosted call was moved to %s", room.InstanceID)
	}
}

// Placement must never be the reason someone cannot talk.
func TestPickInstance_FallsBackWhenRegionSelectionFails(t *testing.T) {
	s, _ := bindingHarness(t)
	s.livekitGetter = &brokenSelectorGetter{uniqueInstanceGetter: uniqueInstanceGetter{
		apiKey: s.encryptionKeyFixture(t, "devkey"), apiSecret: s.encryptionKeyFixture(t, "devsecret"),
	}}

	room, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("join refused because placement failed: %v", err)
	}
	if room.InstanceID != "lk-1" {
		t.Errorf("placed on %s, want the server default", room.InstanceID)
	}
}

type selfHostedGetter struct{ uniqueInstanceGetter }

func (g *selfHostedGetter) GetByServerID(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	inst := g.instance("lk-self-hosted")
	inst.IsPlatformManaged = false
	return inst, nil
}

type brokenSelectorGetter struct{ uniqueInstanceGetter }

func (g *brokenSelectorGetter) GetPlatformInstanceForRegion(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	return nil, fmt.Errorf("no instance available")
}

// The rule that makes a channel one room: the first joiner's region places the call, and everyone
// after follows the binding no matter where they are. A Canadian joining a German channel goes to
// Germany — being sent to Ashburn would put them alone in a room of the same name.
func TestPickInstance_LaterJoinersFollowTheFirstRegardlessOfRegion(t *testing.T) {
	s, _ := bindingHarness(t)

	first, err := s.resolveRoomInstance(withRegion(models.RegionEUCentral), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first joiner: %v", err)
	}
	second, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("second joiner: %v", err)
	}

	if second.InstanceID != first.InstanceID {
		t.Errorf("second joiner landed on %s while the first is on %s — same room name, two SFUs",
			second.InstanceID, first.InstanceID)
	}
}

// Once everyone leaves, the next session must be free to choose again rather than inherit a
// placement made for people who have all gone.
func TestPickInstance_RegionIsChosenAfreshAfterTheChannelEmpties(t *testing.T) {
	s, _ := bindingHarness(t)

	first, err := s.resolveRoomInstance(withRegion(models.RegionEUCentral), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first session: %v", err)
	}
	s.mu.Lock()
	s.releaseChannelInstanceLocked("chan1")
	s.mu.Unlock()

	second, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("second session: %v", err)
	}
	if second.InstanceID == first.InstanceID {
		t.Errorf("both sessions landed on %s — the release did not free the choice", second.InstanceID)
	}
	if second.InstanceID != "lk-"+models.RegionUSEast {
		t.Errorf("second session on %s, want the us-east instance", second.InstanceID)
	}
}

// ── Recovery from a binding that stopped working ───────────────────────────────────────────────

// vanishingGetter serves an instance until it is told the instance is gone, then reports it missing
// the way the repository does when the row has been deleted.
type vanishingGetter struct {
	uniqueInstanceGetter
	gone     map[string]bool
	byIDHits int
}

func (g *vanishingGetter) GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error) {
	g.byIDHits++
	if g.gone[id] {
		return nil, pkg.ErrNotFound
	}
	return g.uniqueInstanceGetter.GetByID(ctx, id)
}

// An admin deleting an instance cascades the persisted row away but cannot reach this process's
// memory, so the claim survives its instance. Migration 090 says such a channel must choose again
// rather than fail; before this, the in-memory path returned the error forever while the persisted
// path recovered — the same failure was survivable through one door and permanent through the other.
func TestResolveRoomInstance_RebindsWhenTheClaimedInstanceIsDeleted(t *testing.T) {
	s, _ := bindingHarness(t)
	getter := &vanishingGetter{
		uniqueInstanceGetter: uniqueInstanceGetter{
			apiKey: s.encryptionKeyFixture(t, "devkey"), apiSecret: s.encryptionKeyFixture(t, "devsecret"),
		},
		gone: map[string]bool{},
	}
	s.livekitGetter = getter

	first, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first join: %v", err)
	}
	getter.gone[first.InstanceID] = true // the admin deletes it mid-call

	second, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("channel became permanently unjoinable after its instance was deleted: %v", err)
	}
	if second.InstanceID == first.InstanceID {
		t.Errorf("rebound to the deleted instance %s", second.InstanceID)
	}
}

// flakyGetter fails a lookup once with a transient error, as a database hiccup would.
type flakyGetter struct {
	uniqueInstanceGetter
	failNext bool
}

func (g *flakyGetter) GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error) {
	if g.failNext {
		g.failNext = false
		return nil, fmt.Errorf("database is temporarily unavailable")
	}
	return g.uniqueInstanceGetter.GetByID(ctx, id)
}

// The other half of the same rule, and the more dangerous one: a transient lookup failure must NOT
// rebind. Releasing the binding of a call that is still running is exactly how the next joiner ends
// up in a same-named room on a different SFU, hearing nobody and seeing no error.
func TestResolveRoomInstance_TransientLookupFailureKeepsTheBinding(t *testing.T) {
	s, _ := bindingHarness(t)
	getter := &flakyGetter{uniqueInstanceGetter: uniqueInstanceGetter{
		apiKey: s.encryptionKeyFixture(t, "devkey"), apiSecret: s.encryptionKeyFixture(t, "devsecret"),
	}}
	s.livekitGetter = getter

	first, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first join: %v", err)
	}

	getter.failNext = true
	if _, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1"); err == nil {
		t.Fatal("a transient database failure was swallowed")
	}

	// The binding must have survived, so the call stays in one place once the database recovers.
	after, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1")
	if err != nil {
		t.Fatalf("join after recovery: %v", err)
	}
	if after.InstanceID != first.InstanceID {
		t.Errorf("a database hiccup moved a live call from %s to %s", first.InstanceID, after.InstanceID)
	}
}

// undecryptableGetter hands out an instance whose stored credentials are not valid ciphertext.
type undecryptableGetter struct{ uniqueInstanceGetter }

func (g *undecryptableGetter) GetPlatformInstanceForRegion(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	inst := g.instance("lk-corrupt")
	inst.APIKey = "not encrypted at all"
	return inst, nil
}

func (g *undecryptableGetter) GetByServerID(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	inst := g.instance("lk-corrupt")
	inst.APIKey = "not encrypted at all"
	return inst, nil
}

// A pick whose credentials cannot be decrypted must leave nothing behind. Claiming first and
// decrypting after would bind the channel to an instance that exists but cannot be used — and the
// recovery above deliberately does not fire for that, because the instance is not missing. The
// channel would stay unjoinable for as long as the claim lived.
func TestResolveRoomInstance_AFailedDecryptLeavesNoBinding(t *testing.T) {
	s, _ := bindingHarness(t)
	s.livekitGetter = &undecryptableGetter{uniqueInstanceGetter: uniqueInstanceGetter{
		apiKey: s.encryptionKeyFixture(t, "devkey"), apiSecret: s.encryptionKeyFixture(t, "devsecret"),
	}}

	if _, err := s.resolveRoomInstance(context.Background(), "srv1", "chan1"); err == nil {
		t.Fatal("undecryptable credentials produced a usable room")
	}

	s.mu.RLock()
	claimed, bound := s.channelInstances["chan1"]
	s.mu.RUnlock()
	if bound {
		t.Errorf("channel left bound to %s after the credentials failed to decrypt", claimed)
	}
}

// ── Teardown must not claim ────────────────────────────────────────────────────────────────────

// The bug this guards was invisible with one instance and fatal with several: every teardown path
// releases the binding when the channel empties and then immediately asks for a room client. While
// that went through the claiming resolver it re-bound the channel it had just freed, from a
// background context with no region — so geo routing worked exactly once per channel, an empty
// channel stayed bound forever, and the SFU removal addressed a machine the participant was never
// on. Reproduced end to end before the fix.
func TestTeardown_DoesNotReclaimTheChannelItJustReleased(t *testing.T) {
	s, _ := bindingHarness(t)

	first, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first join: %v", err)
	}
	s.mu.Lock()
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "chan1", ServerID: "srv1"}
	s.mu.Unlock()

	// Exactly what LeaveChannel does: drop the state, release, then tear down off the lock.
	s.mu.Lock()
	delete(s.states, "u1")
	released := s.cleanupRoomPassphraseIfEmpty("chan1")
	s.mu.Unlock()

	if released != first.InstanceID {
		t.Fatalf("release reported %q, want the instance the call was on (%q)", released, first.InstanceID)
	}

	s.removeParticipantFromLiveKit("srv1", "chan1", "u1", released)

	s.mu.RLock()
	leaked, bound := s.channelInstances["chan1"]
	s.mu.RUnlock()
	if bound {
		t.Errorf("teardown left the empty channel bound to %q", leaked)
	}
}

// The consequence that actually matters to users: without the fix the second call in any channel
// ignored the joiner's region, because teardown had re-bound the channel to a region-blind pick.
func TestTeardown_RegionRoutingStillAppliesToTheNextCall(t *testing.T) {
	s, _ := bindingHarness(t)

	first, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	s.mu.Lock()
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "chan1", ServerID: "srv1"}
	delete(s.states, "u1")
	released := s.cleanupRoomPassphraseIfEmpty("chan1")
	s.mu.Unlock()
	s.removeParticipantFromLiveKit("srv1", "chan1", "u1", released)

	second, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if second.InstanceID != first.InstanceID {
		t.Errorf("second call from the same region landed on %q, first was on %q", second.InstanceID, first.InstanceID)
	}
	if second.InstanceID != "lk-"+models.RegionUSEast {
		t.Errorf("second call on %q — region routing did not apply", second.InstanceID)
	}
}

// A teardown for a channel that still has people in it follows the live binding, and must not
// disturb it.
func TestTeardown_WithOccupantsLeftFollowsTheLiveBinding(t *testing.T) {
	s, _ := bindingHarness(t)

	room, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	s.mu.Lock()
	s.states["u2"] = &models.VoiceState{UserID: "u2", ChannelID: "chan1", ServerID: "srv1"}
	released := s.cleanupRoomPassphraseIfEmpty("chan1") // u2 is still in — must not release
	s.mu.Unlock()

	if released != "" {
		t.Errorf("released %q while the channel still had someone in it", released)
	}

	// The only part of teardown that touches bindings. Called directly so the test does not wait on
	// a real SFU round trip to a fake URL.
	if _, err := s.newLiveKitRoomClient(context.Background(), "chan1", released); err != nil {
		t.Fatalf("teardown could not reach the live room: %v", err)
	}

	s.mu.RLock()
	still, bound := s.channelInstances["chan1"]
	s.mu.RUnlock()
	if !bound || still != room.InstanceID {
		t.Errorf("live binding is now %q/%v, want %q", still, bound, room.InstanceID)
	}
}

// A late clear from a finished session must not erase the binding of the call running now.
func TestBindingStore_StaleClearDoesNotEraseAFreshClaim(t *testing.T) {
	s, _ := bindingHarness(t)
	store := newFakeBindingStore()
	s.bindingStore = store

	first, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	s.mu.Lock()
	s.releaseChannelInstanceLocked("chan1")
	s.mu.Unlock()
	<-store.cleared

	// A different region, so the second session genuinely lands elsewhere — with both sessions on
	// the same instance a stale clear and a current one are indistinguishable, and the case that
	// can actually split a room is the one where they differ.
	second, err := s.resolveRoomInstance(withRegion(models.RegionEUCentral), "srv1", "chan1")
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if second.InstanceID == first.InstanceID {
		t.Fatalf("test setup: both sessions landed on %q", first.InstanceID)
	}

	// The clear from the first session, arriving late. It names the old instance, so it must be a
	// no-op against the row the second session just wrote.
	if err := store.ClearChannelBinding(context.Background(), "chan1", first.InstanceID); err != nil {
		t.Fatalf("late clear: %v", err)
	}
	<-store.cleared

	got, ok := store.get("chan1")
	if !ok || got != second.InstanceID {
		t.Errorf("stored binding is %q/%v after a late clear, want the running call's %q",
			got, ok, second.InstanceID)
	}
}

// The other half of the late-clear guard: a re-claim onto the SAME instance. The named delete
// cannot tell that apart from the clear it was queued for, so the queued clear also checks whether
// the channel has been claimed again before deleting anything.
//
// Made deterministic by the lock: the clear goroutine takes a read lock before it looks, so while
// this test holds the write lock the goroutine cannot observe anything. The re-claim is therefore
// guaranteed to be in place by the time it runs.
func TestBindingStore_ClearSkipsAChannelThatWasClaimedAgain(t *testing.T) {
	s, _ := bindingHarness(t)
	store := newFakeBindingStore()
	s.bindingStore = store

	room, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	s.mu.Lock()
	s.releaseChannelInstanceLocked("chan1") // spawns the clear; it blocks on RLock below
	// A new session claims the same instance before the clear can look.
	s.channelInstances["chan1"] = room.InstanceID
	s.mu.Unlock()

	// The goroutine can run now. If it skipped, the row survives; if it deleted, it erased the
	// binding of a call that is in progress.
	time.Sleep(100 * time.Millisecond)

	got, ok := store.get("chan1")
	if !ok || got != room.InstanceID {
		t.Errorf("stored binding is %q/%v — the queued clear erased a re-claimed channel", got, ok)
	}
}

// The query orders by region but does not filter by it, so it can return an instance on another
// continent. Moving a call there is worse than doing nothing: right after the region column ships
// every instance reads as unknown, the region term is 0 for all of them, and the ordering collapses
// to plain least-loaded — which would send a German caller to whichever box was added most recently.
func TestPickInstance_IgnoresACandidateFromAnotherRegion(t *testing.T) {
	s, _ := bindingHarness(t)
	s.livekitGetter = &mismatchedRegionGetter{
		uniqueInstanceGetter: uniqueInstanceGetter{
			apiKey: s.encryptionKeyFixture(t, "devkey"), apiSecret: s.encryptionKeyFixture(t, "devsecret"),
		},
		elsewhere: models.RegionUSEast,
	}

	room, err := s.resolveRoomInstance(withRegion(models.RegionEUCentral), "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if room.InstanceID == "lk-far-away" {
		t.Error("a eu-central caller was placed on a us-east instance because the ordering had nothing nearer")
	}
	if room.InstanceID != "lk-1" {
		t.Errorf("placed on %s, want the server's own instance", room.InstanceID)
	}
}

// Every instance unknown is the real state of a deployment the day the column ships. Nobody should
// move anywhere until an operator has said where the instances are.
func TestPickInstance_UnsetRegionsLeaveEveryCallWhereItWas(t *testing.T) {
	s, _ := bindingHarness(t)
	s.livekitGetter = &mismatchedRegionGetter{
		uniqueInstanceGetter: uniqueInstanceGetter{
			apiKey: s.encryptionKeyFixture(t, "devkey"), apiSecret: s.encryptionKeyFixture(t, "devsecret"),
		},
		elsewhere: models.RegionUnknown,
	}

	room, err := s.resolveRoomInstance(withRegion(models.RegionEUCentral), "srv1", "chan1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if room.InstanceID != "lk-1" {
		t.Errorf("placed on %s, want the server's own instance", room.InstanceID)
	}
}

// ── The gap between the token and the websocket join ───────────────────────────────────────────

// The binding is claimed when the token is minted; the voice state that governs its lifetime only
// exists once the websocket join arrives. In between, the channel looks empty to everything that
// would clean up after it.
//
// This is the split-room case: the last person leaves while someone else is still completing the
// LiveKit handshake. Release the binding there and the next joiner picks again, opens a room of the
// same name on another SFU, and hears nobody — with no error anywhere.
func TestPendingJoin_LastLeaverDoesNotReleaseUnderAConnectingJoiner(t *testing.T) {
	s, _ := bindingHarness(t)

	room, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("first join: %v", err)
	}
	s.mu.Lock()
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "chan1", ServerID: "srv1"}
	s.mu.Unlock()

	// V asks for a token and starts connecting. No voice state yet.
	s.markPendingJoin("chan1", "v")

	// U leaves. The channel has no states, but V is mid-handshake.
	s.mu.Lock()
	delete(s.states, "u1")
	released := s.cleanupRoomPassphraseIfEmpty("chan1")
	s.mu.Unlock()

	if released != "" {
		t.Fatalf("released %q while a joiner was still connecting", released)
	}

	s.mu.RLock()
	still, bound := s.channelInstances["chan1"]
	s.mu.RUnlock()
	if !bound || still != room.InstanceID {
		t.Fatalf("binding is %q/%v, want it held at %q for the connecting joiner", still, bound, room.InstanceID)
	}

	// V's join lands on the same instance rather than a fresh pick.
	got, err := s.resolveRoomInstance(withRegion(models.RegionEUCentral), "srv1", "chan1")
	if err != nil {
		t.Fatalf("connecting joiner: %v", err)
	}
	if got.InstanceID != room.InstanceID {
		t.Errorf("the connecting joiner landed on %q while the room is on %q — same name, two SFUs",
			got.InstanceID, room.InstanceID)
	}
}

// A token nobody uses must not pin the channel forever. Nothing leaves, so the ordinary release
// never fires; the periodic sweep is the only thing that can free it.
func TestPendingJoin_AnUnusedTokenStopsPinningTheChannel(t *testing.T) {
	s, _ := bindingHarness(t)

	if _, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1"); err != nil {
		t.Fatalf("token: %v", err)
	}
	s.markPendingJoin("chan1", "u1")

	// While the marker is live the channel is held.
	s.mu.Lock()
	s.sweepAbandonedBindingsLocked()
	_, boundEarly := s.channelInstances["chan1"]
	s.mu.Unlock()
	if !boundEarly {
		t.Fatal("the sweep freed a channel someone was still connecting to")
	}

	// The join never arrives and the marker expires.
	s.mu.Lock()
	s.pendingJoins["chan1"]["u1"] = time.Now().Add(-time.Second)
	s.sweepAbandonedBindingsLocked()
	leaked, stillBound := s.channelInstances["chan1"]
	s.mu.Unlock()

	if stillBound {
		t.Errorf("channel still pinned to %q by a token that was never used", leaked)
	}
}

// The sweep must never touch a channel that has people in it.
func TestPendingJoin_SweepLeavesOccupiedChannelsAlone(t *testing.T) {
	s, _ := bindingHarness(t)

	room, err := s.resolveRoomInstance(withRegion(models.RegionUSEast), "srv1", "chan1")
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	s.mu.Lock()
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "chan1", ServerID: "srv1"}
	s.sweepAbandonedBindingsLocked()
	still, bound := s.channelInstances["chan1"]
	s.mu.Unlock()

	if !bound || still != room.InstanceID {
		t.Errorf("the sweep released a live call: %q/%v, want %q", still, bound, room.InstanceID)
	}
}

// A landed join clears the marker, so the channel's lifetime goes back to being governed by the
// voice state alone and an expiring marker cannot free a live call later.
func TestPendingJoin_ClearedOnceTheJoinLands(t *testing.T) {
	s, _ := bindingHarness(t)

	s.markPendingJoin("chan1", "u1")
	s.mu.Lock()
	s.clearPendingJoinLocked("chan1", "u1")
	pending := s.hasPendingJoinLocked("chan1")
	_, mapEntry := s.pendingJoins["chan1"]
	s.mu.Unlock()

	if pending {
		t.Error("marker survived the join")
	}
	if mapEntry {
		t.Error("empty channel entry left in pendingJoins — the map would grow forever")
	}
}

// ── Wiring: the mechanism above is only worth anything if the real paths use it ────────────────

// tokenHarness drives GenerateToken and JoinChannel for real, rather than poking the helpers
// directly. Testing the mechanism proves it works; only this proves it is switched on.
func tokenHarness(t *testing.T, perms models.Permission) (*voiceService, *uniqueInstanceGetter) {
	t.Helper()
	key := make([]byte, 32)
	apiKey, err := crypto.Encrypt("devkey", key)
	if err != nil {
		t.Fatalf("encrypt api key: %v", err)
	}
	apiSecret, err := crypto.Encrypt("devsecret", key)
	if err != nil {
		t.Fatalf("encrypt api secret: %v", err)
	}
	getter := &uniqueInstanceGetter{apiKey: apiKey, apiSecret: apiSecret}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		getter,
		nil,
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return perms, nil
			},
		},
		&testutil.MockBroadcaster{},
		&testutil.MockBroadcastAndOnline{}, // onlineChecker: the orphan sweep dereferences it
		nil,                                // afkTimeoutGetter
		key,
		&testutil.MockFileURLSigner{},
	).(*voiceService)
	return svc, getter
}

func TestGenerateToken_MarksTheChannelWhileTheJoinerConnects(t *testing.T) {
	s, _ := tokenHarness(t, models.PermConnectVoice|models.PermSpeak)

	if _, err := s.GenerateToken(context.Background(), "u1", "u", "", "chan1"); err != nil {
		t.Fatalf("token: %v", err)
	}

	s.mu.Lock()
	pending := s.hasPendingJoinLocked("chan1")
	s.mu.Unlock()
	if !pending {
		t.Error("minting a token did not mark the channel — the binding it just claimed is unprotected")
	}
}

func TestJoinChannel_ClearsTheMarkerTheTokenLeft(t *testing.T) {
	s, _ := tokenHarness(t, models.PermConnectVoice|models.PermSpeak)

	if _, err := s.GenerateToken(context.Background(), "u1", "u", "", "chan1"); err != nil {
		t.Fatalf("token: %v", err)
	}
	if err := s.JoinChannel("u1", "u", "", "", "chan1", false, false); err != nil {
		t.Fatalf("join: %v", err)
	}

	s.mu.Lock()
	pending := s.hasPendingJoinLocked("chan1")
	s.mu.Unlock()
	if pending {
		t.Error("the marker outlived the join it was waiting for")
	}
}

// The claim is a write. Before this it ran ahead of the permission check, so a member without
// PermConnectVoice could pin a staff-only channel to an instance picked for their region and then
// be refused — and nothing released it afterwards.
func TestGenerateToken_RefusedCallerLeavesNoBinding(t *testing.T) {
	s, getter := tokenHarness(t, 0) // no permissions at all

	if _, err := s.GenerateToken(context.Background(), "u1", "u", "", "chan1"); err == nil {
		t.Fatal("a caller with no voice permission was issued a token")
	}

	s.mu.RLock()
	claimed, bound := s.channelInstances["chan1"]
	s.mu.RUnlock()
	if bound {
		t.Errorf("a refused caller claimed %q for the channel", claimed)
	}
	s.mu.Lock()
	pending := s.hasPendingJoinLocked("chan1")
	s.mu.Unlock()
	if pending {
		t.Error("a refused caller left the channel marked as connecting")
	}
	if n := getter.picks.Load(); n != 0 {
		t.Errorf("instance selection ran %d times for a caller who was refused", n)
	}
}

// The sweep has to be reached by the periodic pass, not merely exist.
func TestOrphanSweep_ReleasesAnAbandonedBinding(t *testing.T) {
	s, _ := tokenHarness(t, models.PermConnectVoice)

	if _, err := s.GenerateToken(context.Background(), "u1", "u", "", "chan1"); err != nil {
		t.Fatalf("token: %v", err)
	}
	// The join never arrives and the marker ages out.
	s.mu.Lock()
	s.pendingJoins["chan1"]["u1"] = time.Now().Add(-time.Second)
	s.mu.Unlock()

	s.sweepOrphanStates()

	s.mu.RLock()
	leaked, bound := s.channelInstances["chan1"]
	s.mu.RUnlock()
	if bound {
		t.Errorf("the periodic sweep left the channel pinned to %q by a token nobody used", leaked)
	}
}

// ── Occupied but never bound ───────────────────────────────────────────────────────────────────

// A channel can hold voice state with no binding: MoveUser rewrites state.ChannelID without
// claiming, and the websocket join path never claims at all. Server-side operations then hit a
// channel that has people in it and no room — and must behave as they did before bindings existed,
// which is "the room is empty", not "the lookup failed".
//
// Failing meant the reconciliation sweep skipped the channel with `continue`, so phantom
// participants were never reaped and the channel timer counted forever — reintroducing the stale
// timer bug that sweep exists to fix.
func TestUnbound_ReconciliationSeesAnEmptyRoomRatherThanFailing(t *testing.T) {
	s, _ := bindingHarness(t)
	s.mu.Lock()
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "moved-to", ServerID: "srv1"}
	s.mu.Unlock()

	inRoom, err := s.listLiveKitParticipants(context.Background(), "srv1", "moved-to")
	if err != nil {
		t.Fatalf("reconciliation could not query an unbound channel: %v", err)
	}
	if len(inRoom) != 0 {
		t.Errorf("reported %d participants in a room that does not exist", len(inRoom))
	}
}

// Teardown for a room that was never opened is a no-op, not an error worth logging.
func TestUnbound_TeardownIsASilentNoOp(t *testing.T) {
	s, getter := bindingHarness(t)

	s.removeParticipantFromLiveKit("srv1", "never-bound", "u1", "")

	if n := getter.byIDCalls.Load(); n != 0 {
		t.Errorf("teardown made %d instance lookups for a channel with no room", n)
	}
	s.mu.RLock()
	_, bound := s.channelInstances["never-bound"]
	s.mu.RUnlock()
	if bound {
		t.Error("teardown claimed an instance for a channel it was only tidying up")
	}
}

// A binding this process never held in memory still has to be cleared when the call ends. After a
// restart the clients re-assert over the websocket without asking for a token, so nothing adopts
// the row; left behind, the next session on that channel inherits a placement made for people who
// are long gone and region routing silently stops applying there.
func TestUnbound_StoredBindingIsClearedWhenTheCallEnds(t *testing.T) {
	s, _ := bindingHarness(t)
	store := newFakeBindingStore()
	s.bindingStore = store
	if err := store.SetChannelBinding(context.Background(), "chan1", "lk-from-before-the-restart"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Websocket re-assert: state exists, nothing was adopted.
	s.mu.Lock()
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "chan1", ServerID: "srv1"}
	s.mu.Unlock()

	s.mu.Lock()
	delete(s.states, "u1")
	s.cleanupRoomPassphraseIfEmpty("chan1")
	s.mu.Unlock()

	// Bounded wait, not a bare receive: the clear runs off the caller's path, and a plain
	// `<-store.cleared` turns "it never happened" into a hung test instead of a failing one.
	select {
	case <-store.cleared:
	case <-time.After(2 * time.Second):
		t.Fatal("the stored binding was never cleared")
	}

	if got, ok := store.get("chan1"); ok {
		t.Errorf("stored binding %q outlived the call that used it", got)
	}
}

// The token is issued before the marker used to be set, and the sweep runs every five seconds.
// A tick landing in that gap released a binding whose token had already gone out.
func TestPendingJoin_SweepCannotCatchTheGapAfterTheClaim(t *testing.T) {
	s, _ := tokenHarness(t, models.PermConnectVoice|models.PermSpeak)

	if _, err := s.GenerateToken(context.Background(), "u1", "u", "", "chan1"); err != nil {
		t.Fatalf("token: %v", err)
	}
	s.mu.Lock()
	s.sweepAbandonedBindingsLocked()
	claimed, bound := s.channelInstances["chan1"]
	s.mu.Unlock()

	if !bound {
		t.Fatalf("a sweep tick released the binding of a token that had just been issued (was %q)", claimed)
	}
}

// The screen share sub-participant joins a room that exists. Claiming there would pin the channel
// using a request that carries no region at all — the screen-share handler never sets one.
func TestScreenShare_FollowsTheBindingInsteadOfClaiming(t *testing.T) {
	s, getter := tokenHarness(t, models.PermConnectVoice|models.PermSpeak)
	s.mu.Lock()
	s.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "chan1", ServerID: "srv1"}
	s.mu.Unlock()

	if _, err := s.GenerateScreenShareToken(context.Background(), "u1", "u", "", "chan1"); err == nil {
		t.Fatal("a screen share opened a room for an unbound channel")
	}
	s.mu.RLock()
	claimed, bound := s.channelInstances["chan1"]
	s.mu.RUnlock()
	if bound {
		t.Errorf("screen share claimed %q for a channel with no voice room", claimed)
	}
	if n := getter.picks.Load(); n != 0 {
		t.Errorf("screen share ran instance selection %d times", n)
	}
}
