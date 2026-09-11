package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"

	livekit "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

// countingSFU is livekitStub with per-call counters and a mutable roster, so a test can prove a
// query did not happen, can change who the SFU reports between sweeps, and can run code in the
// middle of phase 2b (the handler executes while the sweep holds no lock).
type countingSFU struct {
	srv     *httptest.Server
	lists   atomic.Int32
	removes atomic.Int32
	mu      sync.Mutex
	roster  []string
	onList  func()
}

func newCountingSFU(t *testing.T, roster ...string) *countingSFU {
	t.Helper()
	c := &countingSFU{roster: roster}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/protobuf")
		var msg proto.Message
		switch {
		case strings.HasSuffix(r.URL.Path, "/ListParticipants"):
			c.lists.Add(1)
			c.mu.Lock()
			hook, roster := c.onList, append([]string(nil), c.roster...)
			c.mu.Unlock()
			if hook != nil {
				hook()
			}
			resp := &livekit.ListParticipantsResponse{}
			for _, id := range roster {
				resp.Participants = append(resp.Participants, &livekit.ParticipantInfo{Identity: id})
			}
			msg = resp
		case strings.HasSuffix(r.URL.Path, "/RemoveParticipant"):
			c.removes.Add(1)
			msg = &livekit.RemoveParticipantResponse{}
		default:
			t.Errorf("unexpected LiveKit call %s", r.URL.Path)
			msg = &livekit.ListParticipantsResponse{}
		}
		body, err := proto.Marshal(msg)
		if err != nil {
			t.Errorf("marshal: %v", err)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *countingSFU) setRoster(ids ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.roster = ids
}

// atomicOnline is an online checker a test can flip from another goroutine without a data race —
// the shared mockOnlineChecker is a bare slice.
type atomicOnline struct{ v atomic.Pointer[[]string] }

func newAtomicOnline(ids ...string) *atomicOnline {
	a := &atomicOnline{}
	a.set(ids...)
	return a
}
func (a *atomicOnline) set(ids ...string)          { a.v.Store(&ids) }
func (a *atomicOnline) GetOnlineUserIDs() []string { return *a.v.Load() }

// sfuHarness is sweepHarness with the channel already bound to the stub, which is what a room the
// SFU can be asked about looks like. Tests that want an unbound channel use sweepHarness directly.
func sfuHarness(t *testing.T, sfu *countingSFU, online ...string) (*voiceService, *[]ws.Event) {
	t.Helper()
	s, broadcasts := sweepHarness(t, sfu.srv.URL, online...)
	bindChannel(s, "ch1")
	return s, broadcasts
}

func sfuHarnessWithChecker(t *testing.T, sfu *countingSFU, checker interface{ GetOnlineUserIDs() []string }) (*voiceService, *[]ws.Event) {
	t.Helper()
	key := make([]byte, 32)
	apiKey, err := crypto.Encrypt("devkey", key)
	if err != nil {
		t.Fatal(err)
	}
	apiSecret, err := crypto.Encrypt("devsecret", key)
	if err != nil {
		t.Fatal(err)
	}
	hub := &testutil.MockBroadcaster{}
	broadcasts := &[]ws.Event{}
	hub.BroadcastToServerFn = func(_ string, e ws.Event) { *broadcasts = append(*broadcasts, e) }
	svc := NewVoiceService(
		&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
		}},
		&urlPinnedGetter{url: sfu.srv.URL, apiKey: apiKey, apiSecret: apiSecret},
		nil, &testutil.MockChannelPermResolver{}, hub, checker, nil, key, &testutil.MockFileURLSigner{},
	)
	s := svc.(*voiceService)
	bindChannel(s, "ch1")
	return s, broadcasts
}

func bindChannel(s *voiceService, channelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.channelInstances[channelID] = "lk1"
}

func expireGrace(s *voiceService, userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.offlineSince[userID] = time.Now().Add(-2 * orphanGracePeriod)
}

func offlineTracked(s *voiceService, userID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.offlineSince[userID]
	return ok
}

func sfuConfirmedAt(s *voiceService, userID string) (time.Time, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	at, ok := s.sfuPresentAt[userID]
	return at, ok
}

// The iOS case in one assertion: the socket is gone past the grace, the SFU still has the user,
// so the user stays — and is not evicted from the room they are audibly in.
func TestOrphanSweep_KeepsAUserTheSFUStillHas(t *testing.T) {
	sfu := newCountingSFU(t, "u1")
	s, broadcasts := sfuHarness(t, sfu)
	putInVoice(s, "u1", "ch1")
	expireGrace(s, "u1")

	s.sweepOrphanStates()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped although the SFU reported the user present — the backgrounded-iOS eviction")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 0 {
		t.Fatalf("broadcast %d leave(s) for a kept user", n)
	}
	if sfu.removes.Load() != 0 {
		t.Fatal("RemoveParticipant called for a user who was kept")
	}
	if !offlineTracked(s, "u1") {
		t.Fatal("offline clock cleared; the websocket is still gone and must keep being tracked")
	}
	if _, ok := sfuConfirmedAt(s, "u1"); !ok {
		t.Fatal("SFU confirmation not recorded; every tick would ask again")
	}
	if sfu.lists.Load() != 1 {
		t.Fatalf("ListParticipants called %d times, want 1", sfu.lists.Load())
	}
}

func TestOrphanSweep_ReapsWhenTheSFUConfirmsAbsence(t *testing.T) {
	sfu := newCountingSFU(t) // room open, nobody in it
	s, broadcasts := sfuHarness(t, sfu)
	putInVoice(s, "u1", "ch1")
	expireGrace(s, "u1")

	s.sweepOrphanStates()

	if stillInVoice(s, "u1") {
		t.Fatal("not reaped although the SFU confirmed absence")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 1 {
		t.Fatalf("broadcast %d leave(s), want exactly 1", n)
	}
	if sfu.removes.Load() != 1 {
		t.Fatalf("RemoveParticipant called %d times for a genuine reap, want 1", sfu.removes.Load())
	}
	if offlineTracked(s, "u1") {
		t.Fatal("offline clock left behind after the reap")
	}
	if _, ok := sfuConfirmedAt(s, "u1"); ok {
		t.Fatal("SFU confirmation left behind after the reap")
	}
}

// Pinned explicitly, not by accident of the "" harness: no binding means no room was ever opened,
// so nobody can be in it, and the reap proceeds without a query. This is what keeps the five
// original orphan guards meaningful under the new rule.
func TestOrphanSweep_UnboundChannelIsAnEmptyRoom(t *testing.T) {
	s, broadcasts := sweepHarness(t, "")
	putInVoice(s, "u1", "ch1")
	expireGrace(s, "u1")

	s.sweepOrphanStates()

	if stillInVoice(s, "u1") {
		t.Fatal("kept a user in a channel that has no room")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 1 {
		t.Fatalf("broadcast %d leave(s), want 1", n)
	}
}

func TestOrphanSweep_KeepsEveryoneWhenTheSFUIsUnreachable(t *testing.T) {
	stub := livekitErrorStub(t, "internal", http.StatusInternalServerError)
	s, broadcasts := sweepHarness(t, stub.URL)
	bindChannel(s, "ch1")
	putInVoice(s, "u1", "ch1")
	putInVoice(s, "u2", "ch1")
	expireGrace(s, "u1")
	expireGrace(s, "u2")

	s.sweepOrphanStates()

	for _, u := range []string{"u1", "u2"} {
		if !stillInVoice(s, u) {
			t.Fatalf("%s reaped on an SFU error — unreachable is not absent", u)
		}
		if !offlineTracked(s, u) {
			t.Fatalf("%s offline clock reset; the next tick must retry, not restart the grace", u)
		}
	}
	if len(*broadcasts) != 0 {
		t.Fatalf("%d broadcast(s) while the SFU was unreachable", len(*broadcasts))
	}
}

func TestOrphanSweep_ScreenShareIdentityCountsAsPresent(t *testing.T) {
	sfu := newCountingSFU(t, "u1_ss")
	s, _ := sfuHarness(t, sfu)
	putInVoice(s, "u1", "ch1")
	expireGrace(s, "u1")

	s.sweepOrphanStates()

	if !stillInVoice(s, "u1") {
		t.Fatal("a user whose only SFU identity is the screen-share sub-participant was reaped")
	}
}

func TestOrphanSweep_DoesNotRequeryAConfirmedUserWithinTheInterval(t *testing.T) {
	sfu := newCountingSFU(t, "u1")
	s, _ := sfuHarness(t, sfu)
	putInVoice(s, "u1", "ch1")
	expireGrace(s, "u1")

	s.sweepOrphanStates()
	s.sweepOrphanStates()
	s.sweepOrphanStates()
	if n := sfu.lists.Load(); n != 1 {
		t.Fatalf("ListParticipants called %d times across three ticks, want 1 — a kept user must not cost a query every 5s", n)
	}

	s.mu.Lock()
	s.sfuPresentAt["u1"] = time.Now().Add(-2 * sfuRecheckInterval)
	s.mu.Unlock()
	s.sweepOrphanStates()
	if n := sfu.lists.Load(); n != 2 {
		t.Fatalf("ListParticipants called %d times after the interval, want 2", n)
	}
}

// Race the decision requires closing: the SFU says gone, but the user reconnects while the SFU is
// being asked. The reap must consult the online set it has now, not the snapshot it started with.
func TestOrphanSweep_ReconnectDuringTheQueryIsNotReaped(t *testing.T) {
	sfu := newCountingSFU(t) // SFU: nobody
	online := newAtomicOnline()
	s, broadcasts := sfuHarnessWithChecker(t, sfu, online)
	putInVoice(s, "u1", "ch1")
	expireGrace(s, "u1")
	sfu.mu.Lock()
	sfu.onList = func() { online.set("u1") } // reconnects mid-query
	sfu.mu.Unlock()

	s.sweepOrphanStates()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped a user who came back online while the SFU was being asked")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 0 {
		t.Fatalf("broadcast %d leave(s)", n)
	}
	if offlineTracked(s, "u1") {
		t.Fatal("offline clock kept for a user who is online again")
	}
}

// The steady-state cost claim, demonstrated: with nobody past the grace there is no query.
func TestOrphanSweep_SteadyStateAsksTheSFUNothing(t *testing.T) {
	sfu := newCountingSFU(t, "u1", "u2")
	s, _ := sfuHarness(t, sfu, "u1", "u2") // both online
	putInVoice(s, "u1", "ch1")
	putInVoice(s, "u2", "ch1")

	for i := 0; i < 3; i++ {
		s.sweepOrphanStates()
	}
	if n := sfu.lists.Load(); n != 0 {
		t.Fatalf("ListParticipants called %d times with everyone online", n)
	}

	// One user drops but is inside the grace: still no query.
	s.mu.Lock()
	s.offlineSince["u2"] = time.Now().Add(-orphanGracePeriod / 2)
	s.mu.Unlock()
	s.onlineChecker.(*mockOnlineChecker).online = []string{"u1"}
	s.sweepOrphanStates()
	if n := sfu.lists.Load(); n != 0 {
		t.Fatalf("ListParticipants called %d times for a user inside the grace", n)
	}
}

// The whole iOS story end to end: backgrounded for a while, kept without being re-asked about,
// then genuinely gone — reaped on the first tick after the re-check interval.
func TestOrphanSweep_BackgroundedThenGone_EndToEnd(t *testing.T) {
	sfu := newCountingSFU(t, "u1")
	s, broadcasts := sfuHarness(t, sfu)
	putInVoice(s, "u1", "ch1")
	expireGrace(s, "u1")

	s.sweepOrphanStates() // asked once, kept
	s.sweepOrphanStates() // not asked again
	if !stillInVoice(s, "u1") || sfu.lists.Load() != 1 {
		t.Fatalf("backgrounded phase: inVoice=%v lists=%d", stillInVoice(s, "u1"), sfu.lists.Load())
	}

	sfu.setRoster() // the user actually leaves the room
	s.sweepOrphanStates()
	if !stillInVoice(s, "u1") {
		t.Fatal("reaped before the re-check interval elapsed; the throttle is not being honoured")
	}

	s.mu.Lock()
	s.sfuPresentAt["u1"] = time.Now().Add(-2 * sfuRecheckInterval)
	s.mu.Unlock()
	s.sweepOrphanStates()
	if stillInVoice(s, "u1") {
		t.Fatal("not reaped once the SFU confirmed absence after the interval")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 1 {
		t.Fatalf("broadcast %d leave(s) over the whole story, want exactly 1", n)
	}
	if sfu.lists.Load() != 2 || sfu.removes.Load() != 1 {
		t.Fatalf("lists=%d removes=%d, want 2 and 1", sfu.lists.Load(), sfu.removes.Load())
	}
}

// ─── VP-05: the ceiling beneath AFK ───

// A server that disabled AFK must still not hold a forgotten phone forever. Past the ceiling the
// SFU's "present" no longer counts, and the eviction must reach the SFU because the session is
// genuinely still live there.
func TestOrphanSweep_CeilingReapsAWebsocketlessUserTheSFUStillHas(t *testing.T) {
	sfu := newCountingSFU(t, "u1")
	s, broadcasts := sfuHarness(t, sfu)
	putInVoice(s, "u1", "ch1")
	s.mu.Lock()
	s.offlineSince["u1"] = time.Now().Add(-(wsAbsentCeiling + time.Minute))
	s.mu.Unlock()

	s.sweepOrphanStates()

	if stillInVoice(s, "u1") {
		t.Fatal("kept past the ceiling — a forgotten phone would hold the channel's timer, binding and chat forever")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 1 {
		t.Fatalf("broadcast %d leave(s), want 1", n)
	}
	if sfu.removes.Load() != 1 {
		t.Fatalf("RemoveParticipant called %d times; the SFU session is still live and must be evicted", sfu.removes.Load())
	}
}

func TestOrphanSweep_InsideTheCeilingTheSFUStillWins(t *testing.T) {
	sfu := newCountingSFU(t, "u1")
	s, broadcasts := sfuHarness(t, sfu)
	putInVoice(s, "u1", "ch1")
	s.mu.Lock()
	s.offlineSince["u1"] = time.Now().Add(-(wsAbsentCeiling - time.Minute))
	s.mu.Unlock()

	s.sweepOrphanStates()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped inside the ceiling while the SFU had them")
	}
	if len(*broadcasts) != 0 {
		t.Fatalf("%d broadcast(s) for a kept user", len(*broadcasts))
	}
}

// AFK is the product's own bound and an admin's setting. If the ceiling ever dropped to or below
// the AFK default (migration 044: 60 min) it would silently override that setting on every server.
func TestOrphanSweep_CeilingSitsAboveTheAFKDefault(t *testing.T) {
	const afkDefault = 60 * time.Minute
	if wsAbsentCeiling <= afkDefault {
		t.Fatalf("wsAbsentCeiling %v must be above the AFK default %v", wsAbsentCeiling, afkDefault)
	}
}
