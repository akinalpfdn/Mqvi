// Package services — guard tests for the two sweeps that decide when a user stops being in a call.
//
// These pin behaviour that was arrived at the hard way and is invisible from the code around it.
// Three production incidents shaped these sweeps, and until this file none of the three had a test:
//
//   - Users kicked for no reason. 0002f50 replaced a fixed 30s ticker, which gave anywhere from 0
//     to 30 seconds of grace depending on phase alignment, with per-user timestamps and a
//     guaranteed 35s. A first sighting must only start the clock, never reap.
//   - Users broken by being online on a second device. GetOnlineUserIDs is per-user, so a user with
//     any live connection is online and this sweep must not touch them. 5e8a367 added the LiveKit
//     sweep precisely because this one cannot see a session abandoned while the user stays online.
//   - Users visible in a channel with no audio. Phantoms. The LiveKit sweep reaps them, but only on
//     confirmed absence: a transient SFU failure must never be read as nobody being there.
//
// Nothing here changes behaviour. Every assertion describes what the code does today, so that a
// later edit that quietly undoes one of the three fixes fails loudly instead of shipping.
package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"

	livekit "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

// ─── Harness ───

// sweepHarness builds a voiceService with a controllable online set, capturing every broadcast.
// instanceURL is where the LiveKit room client will point.
func sweepHarness(t *testing.T, instanceURL string, online ...string) (*voiceService, *[]ws.Event) {
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

	hub := &testutil.MockBroadcaster{}
	broadcasts := &[]ws.Event{}
	hub.BroadcastToServerFn = func(_ string, e ws.Event) { *broadcasts = append(*broadcasts, e) }

	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&urlPinnedGetter{url: instanceURL, apiKey: apiKey, apiSecret: apiSecret},
		nil, // binding store: in-memory only
		&testutil.MockChannelPermResolver{},
		hub,
		&mockOnlineChecker{online: online},
		nil, // afkTimeoutGetter
		key,
		&testutil.MockFileURLSigner{},
	)
	return svc.(*voiceService), broadcasts
}

// urlPinnedGetter hands out one instance whose URL is under the control of the test.
type urlPinnedGetter struct{ url, apiKey, apiSecret string }

func (g *urlPinnedGetter) inst(id string) *models.LiveKitInstance {
	return &models.LiveKitInstance{
		ID: id, URL: g.url, APIKey: g.apiKey, APISecret: g.apiSecret, IsPlatformManaged: true,
	}
}

func (g *urlPinnedGetter) GetByID(_ context.Context, id string) (*models.LiveKitInstance, error) {
	return g.inst(id), nil
}

func (g *urlPinnedGetter) GetByServerID(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	return g.inst("lk1"), nil
}

func (g *urlPinnedGetter) GetPlatformInstanceForRegion(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	return g.inst("lk1"), nil
}

// livekitStub answers ListParticipants with the given identities over Twirp/protobuf, which is what
// the real SDK client speaks: server-sdk-go v2.15.0 builds a NewRoomServiceProtobufClient and posts
// to /twirp/livekit.RoomService/ListParticipants. Verified with a probe before this was written.
func livekitStub(t *testing.T, identities ...string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		resp := &livekit.ListParticipantsResponse{}
		for _, id := range identities {
			resp.Participants = append(resp.Participants, &livekit.ParticipantInfo{Identity: id})
		}
		body, err := proto.Marshal(resp)
		if err != nil {
			t.Errorf("marshal stub response: %v", err)
			return
		}
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// livekitErrorStub answers every call with a Twirp error carrying the given code. not_found is how
// the SFU reports a room it has already closed for being empty.
func livekitErrorStub(t *testing.T, code string, status int) *httptest.Server {
	t.Helper()
	body := []byte("{\"code\":\"" + code + "\",\"msg\":\"stub\"}")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// putInVoice seats a user directly, bypassing JoinChannel: these tests are about the sweeps, and a
// real join would drag broadcast and timer behaviour into assertions that are not about them.
func putInVoice(s *voiceService, userID, channelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states[userID] = &models.VoiceState{
		UserID: userID, ChannelID: channelID, ServerID: "srv1", Username: userID,
		LastActivity: time.Now(),
	}
}

func stillInVoice(s *voiceService, userID string) bool {
	return s.GetUserVoiceState(userID) != nil
}

func isTracked(s *voiceService, m map[string]time.Time, userID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := m[userID]
	return ok
}

func countLeaves(events []ws.Event, userID string) int {
	n := 0
	for _, e := range events {
		if d, ok := e.Data.(ws.VoiceStateUpdateBroadcast); ok && d.UserID == userID && d.Action == "leave" {
			n++
		}
	}
	return n
}

// ─── Orphan sweep: the grace period (regression guard for 0002f50) ───

// The bug 0002f50 fixed: a fixed ticker could reap a user the very first time it noticed them
// offline, giving them no grace at all. The first sighting must only start the clock.
func TestOrphanSweep_FirstSightingOnlyStartsTheClock(t *testing.T) {
	s, broadcasts := sweepHarness(t, "") // nobody online
	putInVoice(s, "u1", "ch1")

	s.sweepOrphanStates()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped on the first sighting — the grace period is gone")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 0 {
		t.Fatalf("broadcast %d leave(s) on the first sighting, want 0", n)
	}
	if !isTracked(s, s.offlineSince, "u1") {
		t.Fatal("the clock was never started, so the user can never be reaped either")
	}
}

func TestOrphanSweep_KeepsAUserInsideTheGracePeriod(t *testing.T) {
	s, broadcasts := sweepHarness(t, "")
	putInVoice(s, "u1", "ch1")

	s.mu.Lock()
	s.offlineSince["u1"] = time.Now().Add(-orphanGracePeriod / 3)
	s.mu.Unlock()

	s.sweepOrphanStates()

	if !stillInVoice(s, "u1") {
		t.Fatalf("reaped after less than the %s grace", orphanGracePeriod)
	}
	if n := countLeaves(*broadcasts, "u1"); n != 0 {
		t.Fatalf("broadcast %d leave(s) inside the grace, want 0", n)
	}
}

func TestOrphanSweep_ReapsOnceTheGraceExpires(t *testing.T) {
	s, broadcasts := sweepHarness(t, "")
	putInVoice(s, "u1", "ch1")

	s.mu.Lock()
	s.offlineSince["u1"] = time.Now().Add(-2 * orphanGracePeriod)
	s.mu.Unlock()

	s.sweepOrphanStates()

	if stillInVoice(s, "u1") {
		t.Fatal("not reaped after the grace expired — abandoned sessions would linger forever")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 1 {
		t.Fatalf("broadcast %d leave(s) on reap, want exactly 1", n)
	}
}

// A user who reconnects inside the grace must have their clock cleared, not merely paused — a
// surviving timestamp would reap them on the next brief drop with no grace at all.
func TestOrphanSweep_ReturningOnlineClearsTheClock(t *testing.T) {
	s, _ := sweepHarness(t, "", "u1") // u1 IS online
	putInVoice(s, "u1", "ch1")

	s.mu.Lock()
	s.offlineSince["u1"] = time.Now().Add(-2 * orphanGracePeriod)
	s.mu.Unlock()

	s.sweepOrphanStates()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped a user who is online — a stale timestamp outlived the reconnect")
	}
	if isTracked(s, s.offlineSince, "u1") {
		t.Fatal("the clock survived the reconnect; the next drop would reap with no grace")
	}
}

// ─── Orphan sweep: multi-device ───

// GetOnlineUserIDs is per-user, not per-connection: a user with any live connection counts as
// online. Someone on a phone and a desktop must never be reaped because one of them went away.
func TestOrphanSweep_NeverTouchesAUserOnlineOnAnotherDevice(t *testing.T) {
	s, broadcasts := sweepHarness(t, "", "u1") // still online via another tab or device
	putInVoice(s, "u1", "ch1")

	for i := 0; i < 3; i++ {
		s.sweepOrphanStates()
	}

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped a user who is online elsewhere")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 0 {
		t.Fatalf("broadcast %d leave(s) for an online user, want 0", n)
	}
	if isTracked(s, s.offlineSince, "u1") {
		t.Fatal("an online user is being tracked as offline")
	}
}

// ─── LiveKit reconciliation: confirmed absence only ───

// The worst of the three failures: reading a transient SFU failure as an empty room reaps everyone
// in a live call at once.
func TestReconcile_SkipsTheChannelWhenLiveKitIsUnreachable(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close() // nothing is listening on that port any more
	s, broadcasts := sweepHarness(t, dead.URL)
	putInVoice(s, "u1", "ch1")
	s.channelInstances["ch1"] = "lk1"

	s.sweepLiveKitReconciliation()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped on an SFU error — a transient failure must never look like an empty room")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 0 {
		t.Fatalf("broadcast %d leave(s) on an SFU error, want 0", n)
	}
	if isTracked(s, s.livekitAbsentSince, "u1") {
		t.Fatal("an unreachable SFU started the absence clock; repeated outages would reap live calls")
	}
}

func TestReconcile_AbsenceIsOnlyTrackedOnFirstSighting(t *testing.T) {
	stub := livekitStub(t) // room exists, nobody in it
	s, broadcasts := sweepHarness(t, stub.URL)
	putInVoice(s, "u1", "ch1")
	s.channelInstances["ch1"] = "lk1"

	s.sweepLiveKitReconciliation()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped on the first absent poll — mid-join and mid-reconnect users would be kicked")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 0 {
		t.Fatalf("broadcast %d leave(s) on the first absent poll, want 0", n)
	}
	if !isTracked(s, s.livekitAbsentSince, "u1") {
		t.Fatal("absence was not recorded, so the phantom can never be reaped")
	}
}

func TestReconcile_KeepsAnAbsentUserInsideTheGrace(t *testing.T) {
	stub := livekitStub(t)
	s, _ := sweepHarness(t, stub.URL)
	putInVoice(s, "u1", "ch1")
	s.channelInstances["ch1"] = "lk1"

	s.mu.Lock()
	s.livekitAbsentSince["u1"] = time.Now().Add(-livekitAbsentGrace / 3)
	s.mu.Unlock()

	s.sweepLiveKitReconciliation()

	if !stillInVoice(s, "u1") {
		t.Fatalf("reaped after less than the %s absence grace", livekitAbsentGrace)
	}
}

func TestReconcile_ReapsThePhantomOnceTheGraceExpires(t *testing.T) {
	stub := livekitStub(t)
	s, broadcasts := sweepHarness(t, stub.URL)
	putInVoice(s, "u1", "ch1")
	s.channelInstances["ch1"] = "lk1"

	s.mu.Lock()
	s.livekitAbsentSince["u1"] = time.Now().Add(-2 * livekitAbsentGrace)
	s.mu.Unlock()

	s.sweepLiveKitReconciliation()

	if stillInVoice(s, "u1") {
		t.Fatal("phantom survived: this is the state that keeps a channel timer running forever")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 1 {
		t.Fatalf("broadcast %d leave(s) on phantom reap, want exactly 1", n)
	}
}

// A user the SFU confirms is present must have their absence clock cleared, or a slow reconnect
// earlier in the session would eventually reap someone who is audibly in the call.
func TestReconcile_PresenceClearsTheAbsenceClock(t *testing.T) {
	stub := livekitStub(t, "u1")
	s, _ := sweepHarness(t, stub.URL)
	putInVoice(s, "u1", "ch1")
	s.channelInstances["ch1"] = "lk1"

	s.mu.Lock()
	s.livekitAbsentSince["u1"] = time.Now().Add(-2 * livekitAbsentGrace)
	s.mu.Unlock()

	s.sweepLiveKitReconciliation()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped a user the SFU reports as present")
	}
	if isTracked(s, s.livekitAbsentSince, "u1") {
		t.Fatal("absence clock survived a confirmed presence")
	}
}

// A screen-share sub-participant identity is {userID}_ss and must count as its owner being present,
// or someone whose only published track is their screen gets reaped mid-share.
func TestReconcile_ScreenShareIdentityCountsAsPresent(t *testing.T) {
	stub := livekitStub(t, "u1_ss")
	s, _ := sweepHarness(t, stub.URL)
	putInVoice(s, "u1", "ch1")
	s.channelInstances["ch1"] = "lk1"

	s.mu.Lock()
	s.livekitAbsentSince["u1"] = time.Now().Add(-2 * livekitAbsentGrace)
	s.mu.Unlock()

	s.sweepLiveKitReconciliation()

	if !stillInVoice(s, "u1") {
		t.Fatal("reaped a user who is present only as a screen-share participant")
	}
}

// Room not found is the SFU saying it closed the room because it was empty. That is a confirmed
// answer, not a failure, and it is exactly the phantom case — so it must reap, unlike the
// unreachable-SFU case above which must not.
func TestReconcile_RoomNotFoundIsAConfirmedEmptyRoom(t *testing.T) {
	stub := livekitErrorStub(t, "not_found", http.StatusNotFound)
	s, broadcasts := sweepHarness(t, stub.URL)
	putInVoice(s, "u1", "ch1")
	s.channelInstances["ch1"] = "lk1"

	s.mu.Lock()
	s.livekitAbsentSince["u1"] = time.Now().Add(-2 * livekitAbsentGrace)
	s.mu.Unlock()

	s.sweepLiveKitReconciliation()

	if stillInVoice(s, "u1") {
		t.Fatal("a closed (empty) room was treated as a failure, so its phantoms are never reaped")
	}
	if n := countLeaves(*broadcasts, "u1"); n != 1 {
		t.Fatalf("broadcast %d leave(s), want exactly 1", n)
	}
}
