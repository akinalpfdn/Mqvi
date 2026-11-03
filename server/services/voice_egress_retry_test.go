package services

import (
	"strings"
	"testing"
	"time"

	"github.com/akinalp/mqvi/ws"
)

// A failed audience read withholds (never leaks), but what it withheld stayed missing until the next
// resync or reconnect. These pin the follow-up: a fresh, ordered resync of the members it affected.

// manualTimers stands in for time.AfterFunc: the test decides when a retry fires.
type manualTimers struct {
	delays  []time.Duration
	pending []func()
}

func (m *manualTimers) after(d time.Duration, f func()) {
	m.delays = append(m.delays, d)
	m.pending = append(m.pending, f)
}

func (m *manualTimers) fire() {
	fs := m.pending
	m.pending = nil
	for _, f := range fs {
		f()
	}
}

func newRetryHarness(t *testing.T) (*audienceHarness, *manualTimers) {
	t.Helper()
	h := newAudienceHarness(t)
	timers := &manualTimers{}
	h.svc.egress.after = timers.after
	return h, timers
}

// lastSync returns the newest voice_server_states_sync userID received, as "user@channel" pairs.
func lastSync(h *audienceHarness, userID string) (string, bool) {
	var found *ws.VoiceServerStatesSyncData
	for _, e := range h.log.to(userID) {
		if e.Op == ws.OpVoiceServerStatesSync {
			d := e.Data.(ws.VoiceServerStatesSyncData)
			found = &d
		}
	}
	if found == nil {
		return "", false
	}
	var parts []string
	for _, st := range found.States {
		parts = append(parts, st.UserID+"@"+st.ChannelID)
	}
	return strings.Join(parts, ","), true
}

func TestEgressRetry_AFailedLiveEventIsFollowedByAResync(t *testing.T) {
	h, timers := newRetryHarness(t)
	h.view.failN = 1

	h.join("insider", hiddenCh)
	if len(mentions(h.log.to("admin"), "insider")) != 0 {
		t.Fatal("admin got the join although the audience read failed")
	}
	if len(timers.pending) != 1 || timers.delays[0] != egressRetryBase {
		t.Fatalf("retries scheduled %d with delays %v, want one after %s", len(timers.pending), timers.delays, egressRetryBase)
	}

	timers.fire()

	if got, ok := lastSync(h, "admin"); !ok || got != "insider@"+hiddenCh {
		t.Fatalf("admin's resync = %q (sent %v), want insider in %s", got, ok, hiddenCh)
	}
	h.requireNothingAbout("member", hiddenCh, "insider")
}

// The retry must not replay the snapshot of the failure: events since then are in the order before it.
func TestEgressRetry_SendsTheStateAtRetryTime(t *testing.T) {
	h, timers := newRetryHarness(t)
	h.view.failN = 1
	h.join("insider", hiddenCh)
	if err := h.svc.LeaveChannel("insider"); err != nil {
		t.Fatalf("leave: %v", err)
	}

	timers.fire()

	if got, ok := lastSync(h, "admin"); !ok || got != "" {
		t.Fatalf("admin's resync = %q (sent %v), want an empty server — the call is over", got, ok)
	}
}

func TestEgressRetry_GivesUpAfterTheLimit(t *testing.T) {
	h, timers := newRetryHarness(t)
	h.view.fail = true

	h.join("insider", hiddenCh)
	for i := 0; i < egressRetryMax+2 && len(timers.pending) > 0; i++ {
		timers.fire()
	}

	want := []time.Duration{egressRetryBase, 2 * egressRetryBase, 4 * egressRetryBase}
	if len(timers.delays) != len(want) {
		t.Fatalf("retries %v, want %v and then none", timers.delays, want)
	}
	for i, d := range want {
		if timers.delays[i] != d {
			t.Fatalf("retry %d after %s, want %s", i, timers.delays[i], d)
		}
	}
	if len(timers.pending) != 0 {
		t.Fatal("a retry is still waiting past the limit")
	}
}

func TestEgressRetry_FailuresWhileOneWaitsJoinIt(t *testing.T) {
	h, timers := newRetryHarness(t)
	h.view.fail = true

	h.join("insider", hiddenCh)
	h.join("member", openCh)

	if len(timers.pending) != 1 {
		t.Fatalf("%d retries waiting for one server, want 1", len(timers.pending))
	}
}

// Under a one-user failure, nobody else is resent anything.
func TestEgressRetry_AFailedServerJoinSyncResyncsThatMemberOnly(t *testing.T) {
	h, timers := newRetryHarness(t)
	h.join("insider", hiddenCh)
	h.join("member", openCh)
	h.log.reset()
	h.view.failN = 1

	h.svc.SyncServerStatesToUser("insider", audServer)
	timers.fire()

	if got, ok := lastSync(h, "insider"); !ok || !strings.Contains(got, "insider@"+hiddenCh) || !strings.Contains(got, "member@"+openCh) {
		t.Fatalf("insider's resync = %q (sent %v), want both calls", got, ok)
	}
	if _, ok := lastSync(h, "admin"); ok {
		t.Fatal("admin was resent the server for someone else's failed read")
	}
}

func TestEgressRetry_AFailedReadySyncIsFollowedByAResync(t *testing.T) {
	h, timers := newRetryHarness(t)
	h.join("insider", hiddenCh)
	h.log.reset()
	h.view.failN = 1

	states, _ := h.svc.VisibleVoiceStates(t.Context(), "admin", []string{audServer})
	if len(states) != 0 {
		t.Fatalf("ready sync showed %d states on a failed read, want only admin's own (none)", len(states))
	}
	timers.fire()

	if got, ok := lastSync(h, "admin"); !ok || got != "insider@"+hiddenCh {
		t.Fatalf("admin's resync = %q (sent %v), want insider in %s", got, ok, hiddenCh)
	}
}

func TestEgressRetry_AFailedResyncIsRetriedForTheSameMembers(t *testing.T) {
	h, timers := newRetryHarness(t)
	h.join("insider", hiddenCh)
	h.log.reset()
	h.view.failN = 1

	h.svc.ResyncUserVisibility(audServer, "admin")
	if got, _ := lastSync(h, "admin"); got != "" {
		t.Fatalf("admin's resync on a failed read = %q, want withheld", got)
	}
	timers.fire()

	if got, ok := lastSync(h, "admin"); !ok || got != "insider@"+hiddenCh {
		t.Fatalf("admin's retried resync = %q (sent %v), want insider in %s", got, ok, hiddenCh)
	}
	if _, ok := lastSync(h, "member"); ok {
		t.Fatal("member was resent the server for admin's failed resync")
	}
}

func TestEgressRetry_NothingScheduledWhenReadsSucceed(t *testing.T) {
	h, timers := newRetryHarness(t)

	h.join("insider", hiddenCh)
	h.svc.SyncServerStatesToUser("member", audServer)
	h.svc.ResyncServerVisibility(audServer)

	if len(timers.pending) != 0 {
		t.Fatalf("%d retries scheduled with every read succeeding", len(timers.pending))
	}
}
