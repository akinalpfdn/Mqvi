package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/ws"
)

// A join whose authorization cannot be read is not refused: after a restart every client re-asserts
// at once and a busy database must not drop people from calls without a word. It is tried again in
// the background, and only a join still undecided after the last try is dropped — with a trace.

// flakyPerms resolves from grants, or fails while broken; counts every read.
type flakyPerms struct {
	mu     sync.Mutex
	g      grants
	broken bool
	reads  int
}

func (f *flakyPerms) read(userID, channelID string) (models.Permission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if f.broken {
		return 0, errors.New("database is locked")
	}
	return f.g[userID+":"+channelID], nil
}

func (f *flakyPerms) ResolveChannelPermissions(_ context.Context, userID, channelID string) (models.Permission, error) {
	return f.read(userID, channelID)
}

func (f *flakyPerms) ResolveChannelPermissionsFresh(_ context.Context, userID, channelID string) (models.Permission, error) {
	return f.read(userID, channelID)
}

func (f *flakyPerms) set(broken bool, g grants) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.broken, f.g = broken, g
}

func (f *flakyPerms) readCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads
}

type onlineUsers struct {
	mu  sync.Mutex
	ids map[string]bool
}

func (o *onlineUsers) GetOnlineUserIDs() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([]string, 0, len(o.ids))
	for id := range o.ids {
		out = append(out, id)
	}
	return out
}

func (o *onlineUsers) setOnline(id string, on bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ids[id] = on
	if !on {
		delete(o.ids, id)
	}
}

// joinEvents records what reached whom, and the admin log, safely across the background tries.
type joinEvents struct {
	mu     sync.Mutex
	toUser map[string][]string // userID -> ops
	joins  int                 // voice_state_update "join" broadcasts
	logs   []string
	joined []string // onJoined calls
}

func (j *joinEvents) Log(_ models.LogLevel, _ models.LogCategory, _, _ *string, message string, _ map[string]string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.logs = append(j.logs, message)
}

func (j *joinEvents) opsTo(userID string) []string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]string(nil), j.toUser[userID]...)
}

func (j *joinEvents) snapshot() (joins int, logs, joined []string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.joins, append([]string(nil), j.logs...), append([]string(nil), j.joined...)
}

// channelReads lets a test fail the channel read or act during it.
type channelReads struct {
	mu     sync.Mutex
	broken bool
	during func()
}

func (c *channelReads) GetByID(ctx context.Context, id string) (*models.Channel, error) {
	c.mu.Lock()
	broken, during := c.broken, c.during
	c.mu.Unlock()
	if during != nil {
		during()
	}
	if broken {
		return nil, errors.New("database is locked")
	}
	return authzChannels{}.GetByID(ctx, id)
}

func (c *channelReads) set(broken bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.broken = broken
}

type deferralHarness struct {
	svc      *voiceService
	perms    *flakyPerms
	online   *onlineUsers
	channels *channelReads
	ev       *joinEvents
}

func newDeferralHarness(t *testing.T, g grants) *deferralHarness {
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
	h := &deferralHarness{
		perms:    &flakyPerms{g: g},
		online:   &onlineUsers{ids: map[string]bool{"u1": true}},
		channels: &channelReads{},
		ev:       &joinEvents{toUser: map[string][]string{}},
	}
	hub := &testutil.MockBroadcaster{
		BroadcastToUserFn: func(userID string, e ws.Event) {
			h.ev.mu.Lock()
			h.ev.toUser[userID] = append(h.ev.toUser[userID], e.Op)
			h.ev.mu.Unlock()
		},
		BroadcastToUsersFn: func(_ []string, e ws.Event) {
			if u, ok := e.Data.(ws.VoiceStateUpdateBroadcast); ok && e.Op == ws.OpVoiceStateUpdate && u.Action == "join" {
				h.ev.mu.Lock()
				h.ev.joins++
				h.ev.mu.Unlock()
			}
		},
	}
	h.svc = NewVoiceService(
		&testutil.MockChannelRepo{GetByIDFn: h.channels.GetByID},
		&workingLiveKitGetter{apiKey: apiKey, apiSecret: apiSecret},
		nil,
		h.perms,
		hub,
		openAudience{}, openAudience{},
		h.online, nil, key, &testutil.MockFileURLSigner{},
		nil,
		nil,
	).(*voiceService)
	h.svc.egress.run = runVoiceEgressInline
	h.svc.joinRetryDelays = []time.Duration{5 * time.Millisecond, 5 * time.Millisecond, 5 * time.Millisecond}
	h.svc.SetAppLogger(h.ev)
	h.svc.SetOnJoined(func(userID, _ string) {
		h.ev.mu.Lock()
		h.ev.joined = append(h.ev.joined, userID)
		h.ev.mu.Unlock()
	})
	return h
}

const connect = models.PermViewChannel | models.PermConnectVoice

func (h *deferralHarness) pending(channelID string) bool {
	h.svc.mu.Lock()
	defer h.svc.mu.Unlock()
	return h.svc.hasPendingJoinLocked(channelID)
}

// settle waits past every background try.
func settle() { time.Sleep(60 * time.Millisecond) }

func TestDeferredJoin_AnUnreadablePermissionIsNotARefusal(t *testing.T) {
	h := newDeferralHarness(t, grants{"u1:vc": connect})
	h.perms.set(true, grants{"u1:vc": connect})

	err := join(h.svc, "u1", "vc")

	if !errors.Is(err, ErrVoiceJoinDeferred) || errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want deferred, not refused — the hub would drop the user from the call", err)
	}
	if h.svc.GetUserVoiceState("u1") != nil {
		t.Fatal("an undecided join created voice state")
	}
	if !h.pending("vc") {
		t.Fatal("no pending marker: the channel's room could be released under the waiting user")
	}
}

func TestDeferredJoin_CompletesWhenTheReadRecovers(t *testing.T) {
	h := newDeferralHarness(t, nil)
	h.perms.set(true, nil)
	_ = join(h.svc, "u1", "vc")

	h.perms.set(false, grants{"u1:vc": connect})
	// onJoined runs after the state is in, outside the lock: wait for both.
	waitFor(t, "the deferred join", func() bool {
		_, _, joined := h.ev.snapshot()
		return h.svc.GetUserVoiceState("u1") != nil && len(joined) > 0
	})

	joins, _, joined := h.ev.snapshot()
	if joins != 1 || len(joined) != 1 {
		t.Fatalf("join announced %d times, onJoined %v — want one of each", joins, joined)
	}
	if got := h.ev.opsTo("u1"); len(got) != 0 {
		t.Fatalf("u1 was sent %v", got)
	}
}

func TestDeferredJoin_StillUnreadableAfterTheLastTryIsDroppedWithATrace(t *testing.T) {
	h := newDeferralHarness(t, nil)
	h.perms.set(true, nil)
	_ = join(h.svc, "u1", "vc")

	waitFor(t, "the drop", func() bool { return len(h.ev.opsTo("u1")) > 0 })

	if got := h.ev.opsTo("u1"); len(got) != 1 || got[0] != ws.OpVoiceForceDisconnect {
		t.Fatalf("u1 was sent %v, want one voice_force_disconnect", got)
	}
	if _, logs, _ := h.ev.snapshot(); len(logs) != 1 {
		t.Fatalf("admin log %v, want one entry for the dropped join", logs)
	}
	if h.svc.GetUserVoiceState("u1") != nil || h.pending("vc") {
		t.Fatal("a dropped join left state or a pending marker")
	}
	if n := h.perms.readCount(); n != 1+len(h.svc.joinRetryDelays) {
		t.Fatalf("%d reads, want the first try and every retry", n)
	}
}

func TestDeferredJoin_ALeaveCancelsIt(t *testing.T) {
	h := newDeferralHarness(t, nil)
	h.perms.set(true, nil)
	_ = join(h.svc, "u1", "vc")

	if err := h.svc.LeaveChannel("u1"); err != nil {
		t.Fatal(err)
	}
	h.perms.set(false, grants{"u1:vc": connect})
	settle()

	if h.svc.GetUserVoiceState("u1") != nil {
		t.Fatal("the user left, and the deferred join put them back in voice")
	}
	if got := h.ev.opsTo("u1"); len(got) != 0 || h.pending("vc") {
		t.Fatalf("after a leave: sent %v, pending %v", got, h.pending("vc"))
	}
}

func TestDeferredJoin_ANewerJoinReplacesIt(t *testing.T) {
	h := newDeferralHarness(t, nil)
	h.perms.set(true, nil)
	_ = join(h.svc, "u1", "vc")

	h.perms.set(false, grants{"u1:vc": connect, "u1:vc2": connect})
	if err := join(h.svc, "u1", "vc2"); err != nil {
		t.Fatalf("newer join: %v", err)
	}
	settle()

	if st := h.svc.GetUserVoiceState("u1"); st == nil || st.ChannelID != "vc2" {
		t.Fatalf("state %+v, want vc2 — the stale try moved the user back", st)
	}
}

func TestDeferredJoin_RefusedOnARetryIsToldToLeave(t *testing.T) {
	h := newDeferralHarness(t, nil)
	h.perms.set(true, nil)
	_ = join(h.svc, "u1", "vc")

	h.perms.set(false, grants{}) // readable now: kicked meanwhile
	waitFor(t, "the refusal", func() bool { return len(h.ev.opsTo("u1")) > 0 })

	if got := h.ev.opsTo("u1"); len(got) != 1 || got[0] != ws.OpVoiceForceDisconnect {
		t.Fatalf("u1 was sent %v, want voice_force_disconnect", got)
	}
	if h.svc.GetUserVoiceState("u1") != nil {
		t.Fatal("a refused retry created voice state")
	}
}

func TestDeferredJoin_AnOfflineUserIsNotJoined(t *testing.T) {
	h := newDeferralHarness(t, nil)
	h.perms.set(true, nil)
	_ = join(h.svc, "u1", "vc")

	h.online.setOnline("u1", false)
	h.perms.set(false, grants{"u1:vc": connect})
	settle()

	if h.svc.GetUserVoiceState("u1") != nil || h.pending("vc") {
		t.Fatal("a user with no websocket was put in voice (or left a pending marker)")
	}
}

// The channel read failing is the same: not a missing channel, a join to try again.
func TestDeferredJoin_AnUnreadableChannelIsDeferredToo(t *testing.T) {
	h := newDeferralHarness(t, grants{"u1:vc": connect})
	h.channels.set(true)

	err := join(h.svc, "u1", "vc")
	if !errors.Is(err, ErrVoiceJoinDeferred) || errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("err = %v, want deferred — not a missing channel", err)
	}

	h.channels.set(false)
	waitFor(t, "the deferred join", func() bool { return h.svc.GetUserVoiceState("u1") != nil })
}

// ─── Re-asserts ───

func TestVoiceJoin_ReassertReadsNoPermission(t *testing.T) {
	h := newDeferralHarness(t, grants{"u1:vc": connect})
	if err := join(h.svc, "u1", "vc"); err != nil {
		t.Fatal(err)
	}
	before := h.perms.readCount()

	if err := join(h.svc, "u1", "vc"); err != nil {
		t.Fatalf("re-assert: %v", err)
	}
	if n := h.perms.readCount() - before; n != 0 {
		t.Fatalf("a re-assert read permissions %d times", n)
	}
}

// Removed between the check and the lock: the re-assert is a new join, and authorized as one.
func TestVoiceJoin_RemovedBeforeTheLockIsDecidedAgain(t *testing.T) {
	h := newDeferralHarness(t, grants{"u1:vc": connect})
	if err := join(h.svc, "u1", "vc"); err != nil {
		t.Fatal(err)
	}
	h.perms.set(false, grants{}) // kicked: no permission any more
	h.channels.mu.Lock()
	h.channels.during = func() {
		h.svc.mu.Lock()
		delete(h.svc.states, "u1")
		h.svc.mu.Unlock()
	}
	h.channels.mu.Unlock()

	err := join(h.svc, "u1", "vc")

	if !errors.Is(err, ErrVoiceJoinRefused) {
		t.Fatalf("err = %v, want refused — a kicked user's re-assert slipped through as a reconnect", err)
	}
	if h.svc.GetUserVoiceState("u1") != nil {
		t.Fatal("the kicked user is back in voice")
	}
}

// A background try that is refused does not tell a user to leave voice they are in by then: some
// other path put them there, and the refusal was about the deferred channel only.
func TestDeferredJoin_ARefusedRetryLeavesAUserInVoiceAlone(t *testing.T) {
	h := newDeferralHarness(t, nil)
	h.perms.set(true, nil)
	_ = join(h.svc, "u1", "vc")

	h.svc.mu.Lock()
	h.svc.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "vc2", ServerID: "srv1"}
	h.svc.mu.Unlock()
	h.perms.set(false, grants{}) // readable: the deferred channel is refused
	settle()

	if got := h.ev.opsTo("u1"); len(got) != 0 {
		t.Fatalf("u1 was sent %v while in voice elsewhere", got)
	}
	if st := h.svc.GetUserVoiceState("u1"); st == nil || st.ChannelID != "vc2" {
		t.Fatalf("state %+v, want u1 still in vc2", st)
	}
}
