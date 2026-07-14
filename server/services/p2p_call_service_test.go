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

	err := svc.InitiateCall("caller", "caller-sess", "receiver", models.P2PCallTypeVoice)
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

	err := svc.InitiateCall("callerB", "callerB-sess", "receiver", models.P2PCallTypeVoice)
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

	err := svc.AcceptCall("rcv", "phone-sess", "phone-dev", "B") // already in active call A
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest when receiver already in a call, got %v", err)
	}
}

// TestInitiateCallRejectsInvalidType verifies call-type validation (rejects
// before any dependency call, so no fakes needed).
func TestInitiateCallRejectsInvalidType(t *testing.T) {
	svc := &p2pCallService{}
	err := svc.InitiateCall("caller", "caller-sess", "receiver", models.P2PCallType("screenshare"))
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest for invalid call type, got %v", err)
	}
}

// TestRelaySignalRejectsNonActive verifies signals are not relayed during
// ringing (reject path returns before any broadcast).
func TestRelaySignalRejectsNonActive(t *testing.T) {
	svc := &p2pCallService{
		activeCalls: map[string]*models.P2PCall{
			"r": {ID: "r", CallerID: "caller", CallerSessionID: "caller-sess",
				ReceiverID: "rcv", Status: models.P2PCallStatusRinging},
		},
	}
	err := svc.RelaySignal("caller", "caller-sess", "r", ws.P2PSignalData{})
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
		if err := svc.DeclineCall("rcv", "phone-dev", "x"); err != nil {
			t.Fatal(err)
		}
		if m := waitCallLog(t, rec.ch); m.Outcome != models.CallOutcomeDeclined {
			t.Errorf("outcome=%q, want declined", m.Outcome)
		}
	})

	t.Run("missed when caller cancels ringing", func(t *testing.T) {
		rec := &recordingCallLogger{ch: make(chan models.CallMeta, 1)}
		svc := newSvc(rec, map[string]*models.P2PCall{"x": ringing(models.P2PCallTypeVoice)}, map[string]string{"caller": "x", "rcv": "x"})
		if err := svc.DeclineCall("caller", "caller-dev", "x"); err != nil {
			t.Fatal(err)
		}
		if m := waitCallLog(t, rec.ch); m.Outcome != models.CallOutcomeMissed {
			t.Errorf("outcome=%q, want missed", m.Outcome)
		}
	})

	t.Run("completed with duration on end", func(t *testing.T) {
		rec := &recordingCallLogger{ch: make(chan models.CallMeta, 1)}
		svc := newSvc(rec, map[string]*models.P2PCall{"x": active(5 * time.Second)}, map[string]string{"caller": "x", "rcv": "x"})
		if err := svc.EndCall("caller", "caller-dev", ""); err != nil {
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
		svc.HandleSessionDisconnect("caller", "caller-sess")
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
		svc.HandleSessionDisconnect("rcv", "rcv-sess")
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
		svc.HandleSessionDisconnect("caller", "caller-sess")
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
		svc.HandleSessionDisconnect("rcv", "rcv-sess")
		if _, ok := svc.activeCalls["x"]; ok {
			t.Error("an active call must tear down on any party disconnect")
		}
	})
}

// ─── Multi-device call teardown ───
//
// A user can be signed in on several devices. The server rings all of them, so every
// path that ends a ringing call must reach the sibling devices too: over WS for the
// ones with a live socket, and via a cancel push for the ones that are backgrounded
// and ringing on the push alone.

// recordingHub captures BroadcastToUser so tests can assert who was told what.
type recordingHub struct {
	fakeHub
	sent []sentEvent
}

type sentEvent struct {
	userID string
	event  ws.Event
}

func (h *recordingHub) BroadcastToUser(userID string, e ws.Event) {
	h.sent = append(h.sent, sentEvent{userID: userID, event: e})
}

func (h *recordingHub) eventsFor(userID, op string) []ws.Event {
	var out []ws.Event
	for _, s := range h.sent {
		if s.userID == userID && s.event.Op == op {
			out = append(out, s.event)
		}
	}
	return out
}

// recordingPush captures cancel pushes. Only NotifyCallCancel is exercised here.
type recordingPush struct {
	cancelled []string // receiverIDs told to stop ringing
	excluded  []string // the device exempted from each cancel
}

func (p *recordingPush) NotifyDM(_, _, _ string, _ bool, _, _ string) {}
func (p *recordingPush) NotifyDMRead(_, _ string)                     {}
func (p *recordingPush) NotifyCall(_, _ string, _ models.P2PCallType, _, _ string) {}
func (p *recordingPush) NotifyCallCancel(receiverID, _, excludeDeviceID string) {
	p.excluded = append(p.excluded, excludeDeviceID)
	p.cancelled = append(p.cancelled, receiverID)
}

func ringingCallService() (*p2pCallService, *recordingHub, *recordingPush) {
	hub := &recordingHub{}
	push := &recordingPush{}
	svc := &p2pCallService{
		hub:          hub,
		pushNotifier: push,
		activeCalls:  map[string]*models.P2PCall{"x": {ID: "x", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusRinging}},
		userCalls:    map[string]string{"caller": "x", "rcv": "x"},
		ringTimers:   map[string]*time.Timer{"x": time.AfterFunc(time.Hour, func() {})},
	}
	return svc, hub, push
}

func TestAcceptCallStopsSiblingDevices(t *testing.T) {
	svc, hub, push := ringingCallService()

	if err := svc.AcceptCall("rcv", "phone-sess", "phone-dev", "x"); err != nil {
		t.Fatalf("AcceptCall: %v", err)
	}

	// The receiver's own sessions must be told, and told WHICH of them accepted — the
	// others have to drop the call rather than negotiate WebRTC alongside the winner.
	own := hub.eventsFor("rcv", ws.OpP2PCallAccept)
	if len(own) != 1 {
		t.Fatalf("receiver's own sessions got %d accept events, want 1", len(own))
	}
	data, ok := own[0].Data.(map[string]string)
	if !ok || data["accepted_by"] != "phone-sess" {
		t.Errorf("accept must name the accepting session, got %v", own[0].Data)
	}
	if got := hub.eventsFor("caller", ws.OpP2PCallAccept); len(got) != 1 {
		t.Errorf("caller got %d accept events, want 1", len(got))
	}
	// A sibling with no live socket is ringing on the push — it needs the cancel.
	if len(push.cancelled) != 1 || push.cancelled[0] != "rcv" {
		t.Errorf("accept must cancel the receiver's ring push, got %v", push.cancelled)
	}
}

// Two devices of the same receiver pressing accept at once: exactly one wins, and the
// broadcast names it. Without a server-assigned winner both devices would believe they
// accepted and both would answer the caller's offer.
func TestConcurrentAcceptHasOneWinner(t *testing.T) {
	svc, hub, _ := ringingCallService()

	err1 := svc.AcceptCall("rcv", "phone-sess", "phone-dev", "x")
	err2 := svc.AcceptCall("rcv", "desktop-sess", "desktop-dev", "x")

	if err1 != nil {
		t.Fatalf("first accept must win: %v", err1)
	}
	if !errors.Is(err2, pkg.ErrBadRequest) {
		t.Fatalf("second accept must be rejected (call no longer ringing), got %v", err2)
	}

	own := hub.eventsFor("rcv", ws.OpP2PCallAccept)
	if len(own) != 1 {
		t.Fatalf("only the winning accept may broadcast, got %d", len(own))
	}
	data, _ := own[0].Data.(map[string]string)
	if data["accepted_by"] != "phone-sess" {
		t.Errorf("accepted_by must name the winner, got %q", data["accepted_by"])
	}
}

func TestDeclineByReceiverStopsSiblingDevices(t *testing.T) {
	svc, hub, push := ringingCallService()

	if err := svc.DeclineCall("rcv", "phone-dev", "x"); err != nil {
		t.Fatalf("DeclineCall: %v", err)
	}

	// Previously only the caller was told, leaving the receiver's other devices ringing.
	own := hub.eventsFor("rcv", ws.OpP2PCallDecline)
	if len(own) != 1 {
		t.Fatalf("receiver's own sessions got %d decline events, want 1", len(own))
	}
	data, ok := own[0].Data.(map[string]string)
	if !ok || data["declined_by"] != "rcv" {
		t.Errorf("decline must carry declined_by=rcv so a sibling stays silent, got %v", own[0].Data)
	}
	if len(hub.eventsFor("caller", ws.OpP2PCallDecline)) != 1 {
		t.Error("caller must still be told the call was declined")
	}
	if len(push.cancelled) != 1 || push.cancelled[0] != "rcv" {
		t.Errorf("a receiver-side decline must cancel the ring push, got %v", push.cancelled)
	}
}

func TestCallerCancelStopsOwnOtherDevices(t *testing.T) {
	svc, hub, push := ringingCallService()

	if err := svc.EndCall("caller", "caller-dev", ""); err != nil {
		t.Fatalf("EndCall: %v", err)
	}

	own := hub.eventsFor("caller", ws.OpP2PCallEnd)
	if len(own) != 1 {
		t.Fatalf("caller's own sessions got %d end events, want 1", len(own))
	}
	data, ok := own[0].Data.(map[string]string)
	if !ok || data["ended_by"] != "caller" {
		t.Errorf("end must carry ended_by=caller, got %v", own[0].Data)
	}
	if len(hub.eventsFor("rcv", ws.OpP2PCallEnd)) != 1 {
		t.Error("receiver must be told the caller hung up")
	}
	if len(push.cancelled) != 1 || push.cancelled[0] != "rcv" {
		t.Errorf("hanging up while ringing must cancel the receiver's ring push, got %v", push.cancelled)
	}
}

// An accepted call that later ends must NOT fire a cancel push — the ring is long over,
// and on iOS a stray cancel would tear down a CallKit call the user is still in.
func TestEndingAnActiveCallSendsNoCancelPush(t *testing.T) {
	hub := &recordingHub{}
	push := &recordingPush{}
	svc := &p2pCallService{
		hub:          hub,
		pushNotifier: push,
		activeCalls:  map[string]*models.P2PCall{"x": {ID: "x", CallerID: "caller", ReceiverID: "rcv", Status: models.P2PCallStatusActive, AcceptedAt: time.Now().Add(-time.Second)}},
		userCalls:    map[string]string{"caller": "x", "rcv": "x"},
		ringTimers:   map[string]*time.Timer{},
	}

	if err := svc.EndCall("rcv", "rcv-dev", ""); err != nil {
		t.Fatalf("EndCall: %v", err)
	}
	if len(push.cancelled) != 0 {
		t.Errorf("an active call must not send a cancel push, got %v", push.cancelled)
	}
}

// The device that answers must NEVER be told to stop ringing.
//
// On iOS that push lands on the live call, and the only way to ignore it is to complete the
// PushKit handler without reporting a call to CallKit — which Apple punishes by killing the app
// and revoking its VoIP delivery. Before the device chain existed, the server had no way to
// address one device, so it blasted all of them and each platform grew a local hack to work out
// whether the push was meant for it. This is what replaced those hacks.
func TestAcceptCallExemptsTheAnsweringDevice(t *testing.T) {
	svc, _, push := ringingCallService()

	if err := svc.AcceptCall("rcv", "phone-sess", "phone-dev", "x"); err != nil {
		t.Fatalf("AcceptCall: %v", err)
	}

	if len(push.excluded) != 1 {
		t.Fatalf("expected exactly one cancel push, got %d", len(push.excluded))
	}
	if push.excluded[0] != "phone-dev" {
		t.Errorf("cancel push exempted %q, want phone-dev — the device that answered must not be told to stop ringing", push.excluded[0])
	}
}

// A RECEIVER declining exempts their own device; a CALLER cancelling has no receiver device to
// exempt, so every one of the receiver's devices must be told.
func TestCancelPushExemptsOnlyTheActingReceiverDevice(t *testing.T) {
	t.Run("receiver declines", func(t *testing.T) {
		svc, _, push := ringingCallService()
		if err := svc.DeclineCall("rcv", "phone-dev", "x"); err != nil {
			t.Fatal(err)
		}
		if len(push.excluded) != 1 || push.excluded[0] != "phone-dev" {
			t.Errorf("exempted %v, want [phone-dev]", push.excluded)
		}
	})

	t.Run("caller cancels", func(t *testing.T) {
		svc, _, push := ringingCallService()
		if err := svc.DeclineCall("caller", "caller-dev", "x"); err != nil {
			t.Fatal(err)
		}
		if len(push.excluded) != 1 || push.excluded[0] != "" {
			t.Errorf("exempted %v, want [\"\"] — the caller's device is not one of the receiver's", push.excluded)
		}
	})

	t.Run("ring times out", func(t *testing.T) {
		svc, _, push := ringingCallService()
		svc.timeoutRinging("x")
		if len(push.excluded) != 1 || push.excluded[0] != "" {
			t.Errorf("exempted %v, want [\"\"] — nobody acted", push.excluded)
		}
	})
}

// ─── FIX-03: a call belongs to two CONNECTIONS, not two users ───

// Bob answers on his phone. His desktop's ring overlay is still up for the round trip it takes
// the accept to arrive. He dismisses it — the most natural gesture there is.
//
// Without a status guard on DeclineCall that DESTROYS the call he just answered, and tells Alice
// he declined. AcceptCall has always had this check; Decline did not.
func TestDeclineCannotKillAnAnsweredCall(t *testing.T) {
	svc, hub, _ := ringingCallService()

	if err := svc.AcceptCall("rcv", "phone-sess", "phone-dev", "x"); err != nil {
		t.Fatalf("AcceptCall: %v", err)
	}

	err := svc.DeclineCall("rcv", "desktop-dev", "x") // the stale desktop overlay
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("declining an ACTIVE call must be rejected, got %v", err)
	}
	if _, alive := svc.activeCalls["x"]; !alive {
		t.Fatal("the live call was destroyed by a stale decline from a sibling device")
	}
	if got := hub.eventsFor("caller", ws.OpP2PCallDecline); len(got) != 0 {
		t.Errorf("the caller was told %q — their live call was reported as declined", got[0].Op)
	}
}

// The caller's OTHER devices see the outgoing call too. They must be able to tell it is not
// theirs, or they flip to active on accept, open a microphone, and send a second SDP offer for
// the same call — the receiver gets two offers and the media session is clobbered.
func TestInitiateNamesTheCallingSession(t *testing.T) {
	hub := &recordingHub{}
	svc := &p2pCallService{
		friendChecker: fakeFriendChecker{}, userGetter: fakeUserGetter{},
		hub: hub, urlSigner: fakeURLSigner{},
		activeCalls: map[string]*models.P2PCall{},
		userCalls:   map[string]string{},
		ringTimers:  map[string]*time.Timer{},
	}

	if err := svc.InitiateCall("caller", "desktop-sess", "rcv", models.P2PCallTypeVoice); err != nil {
		t.Fatalf("InitiateCall: %v", err)
	}

	own := hub.eventsFor("caller", ws.OpP2PCallInitiate)
	if len(own) != 1 {
		t.Fatalf("caller's sessions got %d initiate events, want 1", len(own))
	}
	bc, ok := own[0].Data.(models.P2PCallBroadcast)
	if !ok {
		t.Fatalf("unexpected payload type %T", own[0].Data)
	}
	if bc.InitiatedBy != "desktop-sess" {
		t.Errorf("initiated_by = %q, want desktop-sess — the caller's other devices cannot tell the call is not theirs", bc.InitiatedBy)
	}

	// The receiver has no business knowing which of the caller's devices dialled.
	theirs := hub.eventsFor("rcv", ws.OpP2PCallInitiate)
	if len(theirs) != 1 {
		t.Fatalf("receiver got %d initiate events, want 1", len(theirs))
	}
	rbc := theirs[0].Data.(models.P2PCallBroadcast)
	if rbc.InitiatedBy != "" {
		t.Errorf("the receiver's copy leaked initiated_by = %q", rbc.InitiatedBy)
	}
}

// Signalling is relayed by USER, so a sibling device of either party could inject SDP into a
// call it is not in — the far end takes it as a renegotiation and answers against the wrong
// peer, clobbering the live media session.
func TestRelaySignalRejectsASessionNotInTheCall(t *testing.T) {
	svc, _, _ := ringingCallService()
	if err := svc.AcceptCall("rcv", "phone-sess", "phone-dev", "x"); err != nil {
		t.Fatal(err)
	}
	svc.activeCalls["x"].CallerSessionID = "caller-sess"

	// The caller's OTHER device tries to signal.
	err := svc.RelaySignal("caller", "callers-idle-phone", "x", ws.P2PSignalData{Type: "offer"})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("a sibling session must not be able to signal the call, got %v", err)
	}

	// The session that actually owns it may.
	if err := svc.RelaySignal("caller", "caller-sess", "x", ws.P2PSignalData{Type: "offer"}); err != nil {
		t.Fatalf("the owning session must be able to signal: %v", err)
	}
}

// The regression this branch introduced: teardown used to key on the user's LAST disconnect, so
// a call-carrying socket dying while another device stayed signed in tore down nothing. An
// accepted call has no ring timer, so it stayed Active forever and BOTH parties were permanently
// "already in a call".
func TestCallEndsWhenTheSessionCarryingItDies(t *testing.T) {
	t.Run("the session in the call drops", func(t *testing.T) {
		svc, _, _ := ringingCallService()
		svc.activeCalls["x"].CallerSessionID = "caller-desktop"
		if err := svc.AcceptCall("rcv", "phone-sess", "phone-dev", "x"); err != nil {
			t.Fatal(err)
		}

		svc.HandleSessionDisconnect("caller", "caller-desktop")

		if _, alive := svc.activeCalls["x"]; alive {
			t.Error("the call outlived the connection carrying it — both parties stay busy forever")
		}
		if _, busy := svc.userCalls["rcv"]; busy {
			t.Error("the receiver is still marked as in a call")
		}
	})

	t.Run("a sibling device drops", func(t *testing.T) {
		svc, _, _ := ringingCallService()
		svc.activeCalls["x"].CallerSessionID = "caller-desktop"
		if err := svc.AcceptCall("rcv", "phone-sess", "phone-dev", "x"); err != nil {
			t.Fatal(err)
		}

		svc.HandleSessionDisconnect("caller", "callers-idle-phone")

		if _, alive := svc.activeCalls["x"]; !alive {
			t.Error("an idle sibling device disconnecting ended a call it was not in")
		}
	})
}
