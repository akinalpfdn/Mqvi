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

func (fakeHub) BroadcastToAll(ws.Event)                     {}
func (fakeHub) BroadcastToAllExcept(string, ws.Event)       {}
func (fakeHub) BroadcastToUser(string, ws.Event)            {}
func (fakeHub) BroadcastToUsers([]string, ws.Event)         {}
func (fakeHub) BroadcastToServer(string, ws.Event)          {}
func (fakeHub) BroadcastToServerExcept(string, string, ws.Event) {}
func (fakeHub) GetOnlineUserIDs() []string                  { return nil }
func (fakeHub) GetVisibleOnlineUserIDs() []string           { return nil }
func (fakeHub) GetOnlineUserIDsForServer(string) []string   { return nil }

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
			"caller": "ring",  // caller of a still-ringing call
			"rcv":    "ring",  // callee who hasn't accepted yet
			"c2":     "act",   // both parties of an accepted call
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
