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
func (g *uniqueInstanceGetter) GetPlatformInstanceForRegion(_ context.Context, region string) (*models.LiveKitInstance, error) {
	if region == "" {
		return g.instance("lk-least-loaded"), nil
	}
	return g.instance("lk-" + region), nil
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
	return &voiceService{
		states:           make(map[string]*models.VoiceState),
		roomPassphrases:  make(map[string]string),
		channelInstances: make(map[string]string),
		livekitGetter:    getter,
		encryptionKey:    key,
	}, getter
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

func (f *fakeBindingStore) ClearChannelBinding(_ context.Context, channelID string) error {
	f.mu.Lock()
	delete(f.rows, channelID)
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
