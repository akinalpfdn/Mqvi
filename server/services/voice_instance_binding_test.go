package services

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
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

func (g *uniqueInstanceGetter) GetByID(_ context.Context, id string) (*models.LiveKitInstance, error) {
	g.byIDCalls.Add(1)
	return g.instance(id), nil
}

func (g *uniqueInstanceGetter) instance(id string) *models.LiveKitInstance {
	return &models.LiveKitInstance{
		ID: id, URL: "wss://" + id + ".test", APIKey: g.apiKey, APISecret: g.apiSecret,
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
