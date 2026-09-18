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
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "", "x"); err != nil {
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
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "", "x"); err != nil {
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
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "", "x"); err != nil {
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

	if err := svc.ResumeCall("rcv", "rcv-sess-2", "", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}

	if err := svc.RelaySignal("rcv", "rcv-sess-2", "x", ws.P2PSignalData{Type: "ice-restart"}); err != nil {
		t.Errorf("the reconnected session still cannot signal: %v — the ICE restart would be refused", err)
	}
}

func TestResume_RejectsAStranger(t *testing.T) {
	svc, _ := activeCallService(time.Hour)

	err := svc.ResumeCall("mallory", "mallory-sess", "", "x")

	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("a non-participant reclaimed someone else's call, got %v", err)
	}
}

func TestResume_OnACallThatAlreadyEndedIsNotFound(t *testing.T) {
	svc, _ := activeCallService(time.Hour)

	err := svc.ResumeCall("rcv", "rcv-sess-2", "", "gone")

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
	if err := svc.ResumeCall("caller", "caller-sess-2", "", "x"); err != nil {
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

	if err := svc.ResumeCall("caller", "caller-sess-2", "", "x"); err != nil {
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

	if err := svc.ResumeCall("caller", "caller-sess-2", "", "x"); err != nil {
		t.Fatalf("caller ResumeCall: %v", err)
	}
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "", "x"); err != nil {
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

// The caller's phone moves from Wi-Fi to cellular while the call rings. The old socket is not
// noticed dead yet when the receiver answers, so the caller's offer arrives on the new one.
func TestRingingCaller_ReclaimsTheCallOnANewConnection(t *testing.T) {
	svc, _ := activeCallService(time.Hour)
	svc.activeCalls["x"].Status = models.P2PCallStatusRinging
	svc.activeCalls["x"].CallerInstanceID = "caller-app"

	if err := svc.ResumeCall("caller", "caller-sess-2", "caller-app", "x"); err != nil {
		t.Fatalf("ResumeCall on a ringing call: %v", err)
	}
	if got := svc.activeCalls["x"].CallerSessionID; got != "caller-sess-2" {
		t.Fatalf("call still bound to %q", got)
	}
	if err := svc.AcceptCall("rcv", "rcv-sess", "", "rcv-dev", "x"); err != nil {
		t.Fatalf("AcceptCall: %v", err)
	}
	offer := ws.P2PSignalData{CallID: "x", Type: "offer", SDP: "o"}
	if err := svc.RelaySignal("caller", "caller-sess-2", "x", offer); err != nil {
		t.Errorf("the caller's offer from its new connection was refused: %v", err)
	}
}

// The other order: the old socket is noticed dead before the new one connects. Ending the call
// there sent its end to nobody, and the caller watched it ring to a false "no answer".
func TestRingingCaller_GetsTheGraceWindowToo(t *testing.T) {
	svc, hub := activeCallService(time.Hour)
	svc.activeCalls["x"].Status = models.P2PCallStatusRinging

	svc.HandleSessionDisconnect("caller", "caller-sess")

	if !callExists(svc, "x") {
		t.Fatal("a ringing call was ended the moment the caller's socket dropped")
	}
	if n := len(hub.eventsFor("rcv", ws.OpP2PCallEnd)); n != 0 {
		t.Errorf("the receiver was told the call ended (%d events)", n)
	}
	if err := svc.ResumeCall("caller", "caller-sess-2", "", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}
	svc.mu.RLock()
	_, pending := svc.graceTimers[graceKey("x", "caller")]
	svc.mu.RUnlock()
	if pending {
		t.Error("the teardown is still pending after the caller came back")
	}
}

// A receiver's ringing call has no owner to rebind; resuming it only confirms it is still there.
func TestResume_OfAReceiversRingingCallChangesNothing(t *testing.T) {
	svc, _ := activeCallService(time.Hour)
	svc.activeCalls["x"].Status = models.P2PCallStatusRinging
	svc.activeCalls["x"].ReceiverSessionID = ""

	if err := svc.ResumeCall("rcv", "rcv-sess-2", "", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}
	if got := svc.activeCalls["x"].ReceiverSessionID; got != "" {
		t.Errorf("a ringing call was bound to %q; the receiver's other devices could no longer answer", got)
	}
}

// The call ended while this app was cut off and the end went to the dead socket. Asking about it
// must bring the end back, or a ringing receiver shows it forever.
func TestResumeAndAccept_OfACallThatEndedSendTheEndAgain(t *testing.T) {
	for _, ask := range []func(*p2pCallService) error{
		func(s *p2pCallService) error { return s.ResumeCall("rcv", "rcv-sess-2", "", "gone") },
		func(s *p2pCallService) error { return s.AcceptCall("rcv", "rcv-sess-2", "", "rcv-dev", "gone") },
	} {
		svc, hub := activeCallService(time.Hour)
		if err := ask(svc); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("want not found, got %v", err)
		}
		ends := hub.eventsFor("rcv", ws.OpP2PCallEnd)
		if len(ends) != 1 || ends[0].Data.(map[string]string)["call_id"] != "gone" {
			t.Errorf("the end was not repeated: %v", ends)
		}
	}
}

// Every way a call ends stops both windows, so no timer outlives the call it was counting for.
func TestEveryEndStopsBothGraceWindows(t *testing.T) {
	ends := map[string]func(*p2pCallService){
		// Errors ignored: the call exists, and only the timers are under test.
		"end":     func(s *p2pCallService) { _ = s.EndCall("caller", "", "", "x") },
		"decline": func(s *p2pCallService) { _ = s.DeclineCall("rcv", "", "x") },
		"timeout": func(s *p2pCallService) { s.timeoutRinging("x") },
	}
	for name, end := range ends {
		svc, _ := activeCallService(time.Hour)
		svc.activeCalls["x"].Status = models.P2PCallStatusRinging
		svc.graceTimers[graceKey("x", "caller")] = time.AfterFunc(time.Hour, func() {})
		svc.graceTimers[graceKey("x", "rcv")] = time.AfterFunc(time.Hour, func() {})

		end(svc)

		svc.mu.RLock()
		left := len(svc.graceTimers)
		svc.mu.RUnlock()
		if left != 0 {
			t.Errorf("%s left %d grace timers running", name, left)
		}
	}
}

// The caller locked the phone while it rang; the answer went to the dead socket. Back on a new
// one, it must learn the call was answered, or it rings on and its 30 s timeout hangs it up.
func TestResume_TellsARingingCallerItsCallWasAnswered(t *testing.T) {
	svc, hub := activeCallService(time.Hour)
	svc.activeCalls["x"].CallerInstanceID = "caller-app"
	svc.activeCalls["x"].ReceiverInstanceID = "rcv-app"

	if err := svc.ResumeCall("caller", "caller-sess-2", "caller-app", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}
	accepts := hub.eventsFor("caller", ws.OpP2PCallAccept)
	if len(accepts) != 1 || accepts[0].Data.(map[string]string)["call_id"] != "x" {
		t.Fatalf("the caller was not told its call was answered: %v", accepts)
	}
}

// Another device of the receiver rang, missed the answer, and came back. It is not in the call,
// but it must be told who is, or it rings until the call ends.
func TestResume_TellsASiblingThatMissedTheAnswerWhoHasTheCall(t *testing.T) {
	svc, hub := activeCallService(time.Hour)
	svc.activeCalls["x"].ReceiverInstanceID = "phone-app"

	err := svc.ResumeCall("rcv", "tablet-sess", "tablet-app", "x")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("a sibling took the call: %v", err)
	}
	if got := svc.activeCalls["x"].ReceiverSessionID; got != "rcv-sess" {
		t.Errorf("the call moved to %q", got)
	}
	accepts := hub.eventsFor("rcv", ws.OpP2PCallAccept)
	if len(accepts) != 1 || accepts[0].Data.(map[string]string)["accepted_by_instance"] != "phone-app" {
		t.Errorf("the sibling was not told the phone has the call: %v", accepts)
	}
}

// A sibling still showing the ring must not hang up the call the phone answered — by declining
// after a rejected accept, or by logging out.
func TestEnd_FromAnAppNotInTheAnsweredCallLeavesItRunning(t *testing.T) {
	svc, hub := activeCallService(time.Hour)
	svc.activeCalls["x"].ReceiverInstanceID = "phone-app"

	if err := svc.EndCall("rcv", "tablet-app", "tablet-dev", "x"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("the tablet hung up the phone's call: %v", err)
	}
	if !callExists(svc, "x") {
		t.Fatal("the live call was ended")
	}
	if n := len(hub.eventsFor("rcv", ws.OpP2PCallAccept)); n != 1 {
		t.Errorf("the tablet was not told who has the call (%d accepts)", n)
	}

	// The app in the call, and an app too old to say which it is, still hang up.
	for _, instance := range []string{"phone-app", ""} {
		svc, _ := activeCallService(time.Hour)
		svc.activeCalls["x"].ReceiverInstanceID = "phone-app"
		if err := svc.EndCall("rcv", instance, "phone-dev", "x"); err != nil {
			t.Errorf("instance %q could not hang up: %v", instance, err)
		}
		if callExists(svc, "x") {
			t.Errorf("instance %q: call still up", instance)
		}
	}
}
