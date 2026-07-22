package services

import (
	"errors"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

// A call in progress, owned by a specific connection on each side.
func activeCallService(grace time.Duration) (*p2pCallService, *recordingHub) {
	hub := &recordingHub{}
	svc := &p2pCallService{
		hub:          hub,
		pushNotifier: &recordingPush{},
		activeCalls: map[string]*models.P2PCall{"x": {
			ID: "x", CallerID: "caller", ReceiverID: "rcv",
			Status:            models.P2PCallStatusActive,
			CallerSessionID:   "caller-sess",
			ReceiverSessionID: "rcv-sess",
		}},
		userCalls:   map[string]string{"caller": "x", "rcv": "x"},
		ringTimers:  map[string]*time.Timer{},
		graceTimers: map[string]*time.Timer{},
		graceWindow: grace,
	}
	return svc, hub
}

func callExists(s *p2pCallService, callID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.activeCalls[callID]
	return ok
}

// The regression this phase exists for. WebRTC media is peer-to-peer and never stopped; the
// WebSocket only carries signalling. Tearing the call down the instant that socket blips hangs up
// a call whose audio is still flowing.
func TestActiveCall_SurvivesAReconnectWithinTheGraceWindow(t *testing.T) {
	svc, hub := activeCallService(time.Hour)

	svc.HandleSessionDisconnect("rcv", "rcv-sess")

	if !callExists(svc, "x") {
		t.Fatal("the call was torn down the moment the socket blipped — the media was still flowing")
	}
	if n := len(hub.eventsFor("caller", ws.OpP2PCallEnd)); n != 0 {
		t.Errorf("the other party was told the call ended after %d ms of network trouble", 0)
	}

	// The reconnected client claims it back.
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}
	if !callExists(svc, "x") {
		t.Fatal("the call did not survive the reclaim")
	}
}

// FIX-03's bug must stay fixed: an owner who never comes back leaves both parties permanently
// "already in a call".
func TestActiveCall_EndsWhenNobodyReclaimsIt(t *testing.T) {
	svc, hub := activeCallService(20 * time.Millisecond)

	svc.HandleSessionDisconnect("rcv", "rcv-sess")
	if !callExists(svc, "x") {
		t.Fatal("torn down immediately instead of waiting out the grace window")
	}

	// Wait for the broadcast, not for the call to disappear. Teardown removes the call and then
	// publishes, so polling the first and asserting the second assumes an ordering that does not
	// hold once anything slows the scheduler down — under -race it lost the event about half the
	// time.
	deadline := time.Now().Add(2 * time.Second)
	for len(hub.eventsFor("caller", ws.OpP2PCallEnd)) == 0 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}

	if callExists(svc, "x") {
		t.Fatal("the abandoned call is still Active — both parties are stuck 'already in a call'")
	}
	if n := len(hub.eventsFor("caller", ws.OpP2PCallEnd)); n != 1 {
		t.Errorf("the other party got %d call-end events, want 1", n)
	}
}

// Reclaiming a call cancels its pending teardown.
func TestResume_CancelsThePendingTeardown(t *testing.T) {
	svc, hub := activeCallService(30 * time.Millisecond)

	svc.HandleSessionDisconnect("rcv", "rcv-sess")
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}

	time.Sleep(120 * time.Millisecond) // long past when the timer would have fired

	if !callExists(svc, "x") {
		t.Fatal("the teardown fired anyway on a call that had been reclaimed")
	}
	if n := len(hub.eventsFor("caller", ws.OpP2PCallEnd)); n != 0 {
		t.Errorf("the other party was told the call ended (%d events)", n)
	}
}

// The race Stop() cannot win. If the timer has ALREADY fired and its func is sitting on the mutex
// when ResumeCall takes it, stopping the timer is a no-op — the func runs regardless, and only the
// stale-owner check stops it hanging up a call that was reclaimed a microsecond earlier.
//
// Calling endCallAfterGrace directly IS that race: it is exactly the state the timer func is in
// once it has passed Stop() and is waiting for the lock.
func TestGraceTimer_AStaleFiringDoesNotEndAReclaimedCall(t *testing.T) {
	svc, hub := activeCallService(time.Hour)

	svc.HandleSessionDisconnect("rcv", "rcv-sess")
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}

	// The timer for the DEAD session fires now, after the reclaim.
	svc.endCallAfterGrace("rcv", "rcv-sess", "x")

	if !callExists(svc, "x") {
		t.Fatal("a timer for a session that no longer owns the call hung up the reclaimed call")
	}
	if n := len(hub.eventsFor("caller", ws.OpP2PCallEnd)); n != 0 {
		t.Errorf("the stale timer told the other party the call ended (%d events)", n)
	}
}

// The rebind is not bookkeeping: RelaySignal rejects a sender session that owns nothing, and the
// session id changes on every reconnect. Without it the ICE restart that recovers the media after
// the blip is refused as coming from a stranger.
func TestResume_LetsTheNewSessionSignalAgain(t *testing.T) {
	svc, _ := activeCallService(time.Hour)

	svc.HandleSessionDisconnect("rcv", "rcv-sess")

	err := svc.RelaySignal("rcv", "rcv-sess-2", "x", ws.P2PSignalData{Type: "ice-restart"})
	if !errors.Is(err, pkg.ErrForbidden) && !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("a signal from an unclaimed session was accepted (err=%v)", err)
	}

	if err := svc.ResumeCall("rcv", "rcv-sess-2", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}

	if err := svc.RelaySignal("rcv", "rcv-sess-2", "x", ws.P2PSignalData{Type: "ice-restart"}); err != nil {
		t.Errorf("the reconnected session still cannot signal: %v — the ICE restart would be refused", err)
	}
}

func TestResume_RejectsAStranger(t *testing.T) {
	svc, _ := activeCallService(time.Hour)

	err := svc.ResumeCall("mallory", "mallory-sess", "x")

	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("a non-participant reclaimed someone else's call, got %v", err)
	}
}

func TestResume_OnACallThatAlreadyEndedIsNotFound(t *testing.T) {
	svc, _ := activeCallService(time.Hour)

	err := svc.ResumeCall("rcv", "rcv-sess-2", "gone")

	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

// A sibling device dropping is not the call dropping.
func TestSiblingDisconnect_LeavesTheCallAloneAndSchedulesNothing(t *testing.T) {
	svc, _ := activeCallService(20 * time.Millisecond)

	svc.HandleSessionDisconnect("rcv", "some-other-device")

	time.Sleep(80 * time.Millisecond)

	if !callExists(svc, "x") {
		t.Fatal("a sibling device's socket closing ended the call")
	}
}

// The grace is per CONNECTION, not per call — and this is the bug my first version shipped.
//
// The receiver's socket dies and its teardown is scheduled. The CALLER's socket then reconnects
// for any reason (one dropped router takes both of them out) and its client sends
// p2p_call_resume on `ready`. Keyed by call alone, that cancelled the RECEIVER's teardown: the
// receiver never came back, and the call stayed Active forever — both parties permanently
// "already in a call". That is precisely the bug FIX-03 fixed, resurrected.
func TestGrace_OneSideReturningDoesNotSpeakForTheOther(t *testing.T) {
	svc, _ := activeCallService(30 * time.Millisecond)

	svc.HandleSessionDisconnect("rcv", "rcv-sess") // the receiver is gone

	// The caller reclaims its own connection. The receiver is STILL gone.
	if err := svc.ResumeCall("caller", "caller-sess-2", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for callExists(svc, "x") && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}

	if callExists(svc, "x") {
		t.Fatal("the receiver never came back, yet the call is still Active — both parties are now permanently 'already in a call'")
	}
}

// Both sides drop together (the same router), then only one comes back.
func TestGrace_BothDropAndOnlyOneReturns(t *testing.T) {
	svc, _ := activeCallService(30 * time.Millisecond)

	svc.HandleSessionDisconnect("rcv", "rcv-sess")
	svc.HandleSessionDisconnect("caller", "caller-sess")

	if err := svc.ResumeCall("caller", "caller-sess-2", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for callExists(svc, "x") && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}

	if callExists(svc, "x") {
		t.Fatal("only the caller came back, yet the call is still Active")
	}
}

// And when BOTH come back, the call lives.
func TestGrace_BothDropAndBothReturn(t *testing.T) {
	svc, hub := activeCallService(30 * time.Millisecond)

	svc.HandleSessionDisconnect("rcv", "rcv-sess")
	svc.HandleSessionDisconnect("caller", "caller-sess")

	if err := svc.ResumeCall("caller", "caller-sess-2", "x"); err != nil {
		t.Fatalf("caller ResumeCall: %v", err)
	}
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "x"); err != nil {
		t.Fatalf("receiver ResumeCall: %v", err)
	}

	time.Sleep(120 * time.Millisecond)

	if !callExists(svc, "x") {
		t.Fatal("both parties reconnected and the call was hung up anyway")
	}
	if n := len(hub.eventsFor("caller", ws.OpP2PCallEnd)); n != 0 {
		t.Errorf("a call both parties reclaimed still reported %d end events", n)
	}
}
