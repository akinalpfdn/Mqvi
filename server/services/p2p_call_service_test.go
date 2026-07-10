package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

// fakeHub is a no-op ws.BroadcastAndOnline for exercising broadcast paths.
type fakeHub struct{}

func (fakeHub) BroadcastToAll(ws.Event)                           {}
func (fakeHub) BroadcastToAllExcept(string, ws.Event)             {}
func (fakeHub) BroadcastToUser(string, ws.Event)                  {}
func (fakeHub) BroadcastToUsers([]string, ws.Event)               {}
func (fakeHub) BroadcastToServer(string, ws.Event)                {}
func (fakeHub) BroadcastToServerExcept(string, string, ws.Event)  {}
func (fakeHub) GetOnlineUserIDs() []string                        { return nil }
func (fakeHub) GetVisibleOnlineUserIDs() []string                 { return nil }
func (fakeHub) GetOnlineUserIDsForServer(string) []string         { return nil }
func (fakeHub) GetOnlineCountsForServers([]string) map[string]int { return nil }

// Minimal fakes — only the methods InitiateCall reaches before the busy-check.

type fakeFriendChecker struct{}

func (fakeFriendChecker) GetByPair(_ context.Context, _, _ string) (*models.Friendship, error) {
	return &models.Friendship{Status: models.FriendshipStatusAccepted}, nil
}

type fakeUserGetter struct{}

func (fakeUserGetter) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id}, nil
}
func (fakeUserGetter) GetActiveByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id}, nil
}

// fakeURLSigner is a pass-through signer for buildBroadcast in tests.
type fakeURLSigner struct{}

func (fakeURLSigner) SignURL(s string) string      { return s }
func (fakeURLSigner) SignURLPtr(p *string) *string { return p }

// TestHasActiveCall verifies the TURN credential gate boundary: only an
// accepted (active) call qualifies — ringing, stale, or absent must not.
// Constructs the struct directly (same package) and populates the two state
// maps HasActiveCall reads, so no hub/repo fakes are needed.
func TestHasActiveCall(t *testing.T) {
	svc := &p2pCallService{
		activeCalls: map[string]*models.P2PCall{
			"ring": {ID: "ring", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusRinging},
			"act":  {ID: "act", CallerID: "c2", ReceiverID: "r2", Status: models.P2PCallStatusActive},
		},
		userCalls: map[string]string{
			"caller": "ring", // caller of a still-ringing call
			"rcv":    "ring", // callee who hasn't accepted yet
			"c2":     "act",  // both parties of an accepted call
			"r2":     "act",
			"stale":  "ghost", // points at a call no longer in activeCalls
		},
	}

	cases := []struct {
		name string
		user string
		want bool
	}{
		{"no call at all", "nobody", false},
		{"ringing caller is not enough", "caller", false},
		{"ringing callee is not enough", "rcv", false},
		{"active caller allowed", "c2", true},
		{"active callee allowed", "r2", true},
		{"stale pointer is not active", "stale", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := svc.HasActiveCall(tc.user); got != tc.want {
				t.Errorf("HasActiveCall(%q) = %v, want %v", tc.user, got, tc.want)
			}
		})
	}
}

// TestInitiateCallRejectsDuplicateCaller verifies the busy guard: a caller
// already in a call cannot start another. The reject path returns before any
// broadcast, so no hub fake is needed.
func TestInitiateCallRejectsDuplicateCaller(t *testing.T) {
	svc := &p2pCallService{
		friendChecker: fakeFriendChecker{},
		userGetter:    fakeUserGetter{},
		activeCalls:   map[string]*models.P2PCall{"existing": {ID: "existing", CallerID: "caller", ReceiverID: "other", Status: models.P2PCallStatusActive}},
		userCalls:     map[string]string{"caller": "existing"},
	}

	err := svc.InitiateCall("caller", "receiver", models.P2PCallTypeVoice)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest when caller already in a call, got %v", err)
	}
}

// TestInitiateCallRejectsBusyReceiver verifies that once a receiver is reserved
// (ringing or active), a second caller to them gets "busy" — preventing two
// concurrent ringing calls the single-call frontend can't model.
func TestInitiateCallRejectsBusyReceiver(t *testing.T) {
	svc := &p2pCallService{
		friendChecker: fakeFriendChecker{},
		userGetter:    fakeUserGetter{},
		hub:           fakeHub{},
		activeCalls:   map[string]*models.P2PCall{"existing": {ID: "existing", CallerID: "other", ReceiverID: "receiver", Status: models.P2PCallStatusRinging}},
		userCalls:     map[string]string{"other": "existing", "receiver": "existing"},
		ringTimers:    map[string]*time.Timer{},
	}

	err := svc.InitiateCall("callerB", "receiver", models.P2PCallTypeVoice)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected busy error when receiver is already reserved, got %v", err)
	}
}

// TestAcceptCallRejectsBusyReceiver verifies a receiver already in a call cannot
// accept a second ringing call. Reject path returns before any broadcast.
func TestAcceptCallRejectsBusyReceiver(t *testing.T) {
	svc := &p2pCallService{
		activeCalls: map[string]*models.P2PCall{
			"A": {ID: "A", CallerID: "c1", ReceiverID: "rcv", Status: models.P2PCallStatusActive},
			"B": {ID: "B", CallerID: "c2", ReceiverID: "rcv", Status: models.P2PCallStatusRinging},
		},
		userCalls: map[string]string{"c1": "A", "rcv": "A", "c2": "B"},
	}

	err := svc.AcceptCall("rcv", "B") // already in active call A
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest when receiver already in a call, got %v", err)
	}
}

// TestInitiateCallRejectsInvalidType verifies call-type validation (rejects
// before any dependency call, so no fakes needed).
func TestInitiateCallRejectsInvalidType(t *testing.T) {
	svc := &p2pCallService{}
	err := svc.InitiateCall("caller", "receiver", models.P2PCallType("screenshare"))
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest for invalid call type, got %v", err)
	}
}

// TestRelaySignalRejectsNonActive verifies signals are not relayed during
// ringing (reject path returns before any broadcast).
func TestRelaySignalRejectsNonActive(t *testing.T) {
	svc := &p2pCallService{
		activeCalls: map[string]*models.P2PCall{
			"r": {ID: "r", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusRinging},
		},
	}
	err := svc.RelaySignal("caller", "r", ws.P2PSignalData{})
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest relaying during ringing, got %v", err)
	}
}

// recordingCallLogger captures call-log metadata for assertions. logCall runs
// in a goroutine, so the test synchronizes by receiving from the channel.
type recordingCallLogger struct {
	ch chan models.CallMeta
}

func (r *recordingCallLogger) CreateCallLog(_ context.Context, _, _ string, meta models.CallMeta) error {
	r.ch <- meta
	return nil
}

func waitCallLog(t *testing.T, ch chan models.CallMeta) models.CallMeta {
	t.Helper()
	select {
	case m := <-ch:
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("expected a call-log entry, got none")
		return models.CallMeta{}
	}
}

// TestCallLogging verifies each call-end path writes a call-log entry with the
// correct outcome (and duration for completed calls).
func TestCallLogging(t *testing.T) {
	newSvc := func(logger CallLogger, calls map[string]*models.P2PCall, userCalls map[string]string) *p2pCallService {
		return &p2pCallService{
			hub:         fakeHub{},
			callLogger:  logger,
			activeCalls: calls,
			userCalls:   userCalls,
			ringTimers:  map[string]*time.Timer{},
		}
	}
	ringing := func(t models.P2PCallType) *models.P2PCall {
		return &models.P2PCall{ID: "x", CallerID: "caller", ReceiverID: "rcv", CallType: t, Status: models.P2PCallStatusRinging}
	}
	active := func(since time.Duration) *models.P2PCall {
		return &models.P2PCall{ID: "x", CallerID: "caller", ReceiverID: "rcv", CallType: models.P2PCallTypeVoice, Status: models.P2PCallStatusActive, AcceptedAt: time.Now().Add(-since)}
	}

	t.Run("missed on ring timeout", func(t *testing.T) {
		rec := &recordingCallLogger{ch: make(chan models.CallMeta, 1)}
		svc := newSvc(rec, map[string]*models.P2PCall{"x": ringing(models.P2PCallTypeVoice)}, map[string]string{"caller": "x", "rcv": "x"})
		svc.timeoutRinging("x")
		if m := waitCallLog(t, rec.ch); m.Outcome != models.CallOutcomeMissed || m.CallerID != "caller" {
			t.Errorf("got outcome=%q caller=%q, want missed/caller", m.Outcome, m.CallerID)
		}
	})

	t.Run("declined by receiver", func(t *testing.T) {
		rec := &recordingCallLogger{ch: make(chan models.CallMeta, 1)}
		svc := newSvc(rec, map[string]*models.P2PCall{"x": ringing(models.P2PCallTypeVideo)}, map[string]string{"caller": "x", "rcv": "x"})
		if err := svc.DeclineCall("rcv", "x"); err != nil {
			t.Fatal(err)
		}
		if m := waitCallLog(t, rec.ch); m.Outcome != models.CallOutcomeDeclined {
			t.Errorf("outcome=%q, want declined", m.Outcome)
		}
	})

	t.Run("missed when caller cancels ringing", func(t *testing.T) {
		rec := &recordingCallLogger{ch: make(chan models.CallMeta, 1)}
		svc := newSvc(rec, map[string]*models.P2PCall{"x": ringing(models.P2PCallTypeVoice)}, map[string]string{"caller": "x", "rcv": "x"})
		if err := svc.DeclineCall("caller", "x"); err != nil {
			t.Fatal(err)
		}
		if m := waitCallLog(t, rec.ch); m.Outcome != models.CallOutcomeMissed {
			t.Errorf("outcome=%q, want missed", m.Outcome)
		}
	})

	t.Run("completed with duration on end", func(t *testing.T) {
		rec := &recordingCallLogger{ch: make(chan models.CallMeta, 1)}
		svc := newSvc(rec, map[string]*models.P2PCall{"x": active(5 * time.Second)}, map[string]string{"caller": "x", "rcv": "x"})
		if err := svc.EndCall("caller"); err != nil {
			t.Fatal(err)
		}
		m := waitCallLog(t, rec.ch)
		if m.Outcome != models.CallOutcomeCompleted {
			t.Errorf("outcome=%q, want completed", m.Outcome)
		}
		if m.DurationSec < 4 {
			t.Errorf("duration=%d, want >= 4", m.DurationSec)
		}
	})

	t.Run("completed on disconnect during active call", func(t *testing.T) {
		rec := &recordingCallLogger{ch: make(chan models.CallMeta, 1)}
		svc := newSvc(rec, map[string]*models.P2PCall{"x": active(3 * time.Second)}, map[string]string{"caller": "x", "rcv": "x"})
		svc.HandleDisconnect("caller")
		if m := waitCallLog(t, rec.ch); m.Outcome != models.CallOutcomeCompleted {
			t.Errorf("outcome=%q, want completed", m.Outcome)
		}
	})
}

// TestTimeoutRinging verifies an unanswered ringing call is cleaned up, while an
// already-accepted call is left intact (timer fired after accept).
func TestTimeoutRinging(t *testing.T) {
	t.Run("cleans up a still-ringing call", func(t *testing.T) {
		svc := &p2pCallService{
			hub:         fakeHub{},
			activeCalls: map[string]*models.P2PCall{"r": {ID: "r", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusRinging}},
			userCalls:   map[string]string{"caller": "r"},
			ringTimers:  map[string]*time.Timer{"r": time.AfterFunc(time.Hour, func() {})},
		}
		svc.timeoutRinging("r")
		if _, ok := svc.activeCalls["r"]; ok {
			t.Error("ringing call should be removed on timeout")
		}
		if _, ok := svc.userCalls["caller"]; ok {
			t.Error("caller mapping should be removed on timeout")
		}
		if _, ok := svc.ringTimers["r"]; ok {
			t.Error("timer should be removed on timeout")
		}
	})

	t.Run("leaves an accepted call intact", func(t *testing.T) {
		svc := &p2pCallService{
			hub:         fakeHub{},
			activeCalls: map[string]*models.P2PCall{"a": {ID: "a", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusActive}},
			userCalls:   map[string]string{"caller": "a", "rcv": "a"},
			ringTimers:  map[string]*time.Timer{},
		}
		svc.timeoutRinging("a")
		if _, ok := svc.activeCalls["a"]; !ok {
			t.Error("accepted call must NOT be removed by a stale ringing timeout")
		}
	})
}

// TestPendingIncomingCall verifies the connect-time replay gating: only the
// RECEIVER of a still-RINGING call gets re-delivered the incoming call. Caller,
// active calls, and users with no call must get nil.
func TestPendingIncomingCall(t *testing.T) {
	svc := &p2pCallService{
		userGetter: fakeUserGetter{},
		urlSigner:  fakeURLSigner{},
		activeCalls: map[string]*models.P2PCall{
			"x": {ID: "x", CallerID: "caller", ReceiverID: "rcv", CallType: models.P2PCallTypeVoice, Status: models.P2PCallStatusRinging},
			"y": {ID: "y", CallerID: "c2", ReceiverID: "r2", Status: models.P2PCallStatusActive},
		},
		userCalls: map[string]string{"caller": "x", "rcv": "x", "c2": "y", "r2": "y"},
	}

	t.Run("ringing receiver gets the broadcast", func(t *testing.T) {
		bc := svc.PendingIncomingCall("rcv")
		if bc == nil {
			t.Fatal("expected a broadcast for a ringing receiver, got nil")
		}
		if bc.ID != "x" || bc.ReceiverID != "rcv" {
			t.Errorf("wrong broadcast: %+v", bc)
		}
	})
	t.Run("caller of a ringing call gets nil", func(t *testing.T) {
		if bc := svc.PendingIncomingCall("caller"); bc != nil {
			t.Errorf("caller must not get a replay, got %+v", bc)
		}
	})
	t.Run("active-call receiver gets nil (only ringing replays)", func(t *testing.T) {
		if bc := svc.PendingIncomingCall("r2"); bc != nil {
			t.Errorf("active call must not replay, got %+v", bc)
		}
	})
	t.Run("user with no call gets nil", func(t *testing.T) {
		if bc := svc.PendingIncomingCall("nobody"); bc != nil {
			t.Errorf("expected nil, got %+v", bc)
		}
	})
}

// TestHandleDisconnectRingingReceiver verifies a receiver dropping its socket while
// a call is still RINGING keeps the call alive (a mobile client may be backgrounding
// to answer from its push), while a caller drop or an active call still tears down.
func TestHandleDisconnectRingingReceiver(t *testing.T) {
	t.Run("receiver disconnect during ringing keeps the call", func(t *testing.T) {
		svc := &p2pCallService{
			hub:         fakeHub{},
			activeCalls: map[string]*models.P2PCall{"x": {ID: "x", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusRinging}},
			userCalls:   map[string]string{"caller": "x", "rcv": "x"},
			ringTimers:  map[string]*time.Timer{"x": time.AfterFunc(time.Hour, func() {})},
		}
		svc.HandleDisconnect("rcv")
		if _, ok := svc.activeCalls["x"]; !ok {
			t.Error("ringing call must survive a receiver disconnect (mobile may answer via push)")
		}
		if _, ok := svc.userCalls["rcv"]; !ok {
			t.Error("receiver mapping must be kept so PendingIncomingCall can replay")
		}
		if _, ok := svc.ringTimers["x"]; !ok {
			t.Error("ring timer must keep running to time out at 60s")
		}
	})

	t.Run("caller disconnect during ringing tears down", func(t *testing.T) {
		svc := &p2pCallService{
			hub:         fakeHub{},
			activeCalls: map[string]*models.P2PCall{"x": {ID: "x", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusRinging}},
			userCalls:   map[string]string{"caller": "x", "rcv": "x"},
			ringTimers:  map[string]*time.Timer{"x": time.AfterFunc(time.Hour, func() {})},
		}
		svc.HandleDisconnect("caller")
		if _, ok := svc.activeCalls["x"]; ok {
			t.Error("caller leaving a ringing call must tear it down")
		}
	})

	t.Run("active-call disconnect tears down", func(t *testing.T) {
		svc := &p2pCallService{
			hub:         fakeHub{},
			activeCalls: map[string]*models.P2PCall{"x": {ID: "x", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusActive, AcceptedAt: time.Now().Add(-time.Second)}},
			userCalls:   map[string]string{"caller": "x", "rcv": "x"},
			ringTimers:  map[string]*time.Timer{},
		}
		svc.HandleDisconnect("rcv")
		if _, ok := svc.activeCalls["x"]; ok {
			t.Error("an active call must tear down on any party disconnect")
		}
	})
}
