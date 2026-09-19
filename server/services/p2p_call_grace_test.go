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
		userCalls:    map[string]string{"caller": "x", "rcv": "x"},
		ringTimers:   map[string]*time.Timer{},
		graceTimers:  map[string]*time.Timer{},
		nativeAbsent: map[string]bool{},
		graceWindow:  grace,
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

	svc.HandleSessionDisconnect("rcv", "rcv-sess", false)

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

	svc.HandleSessionDisconnect("rcv", "rcv-sess", false)
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

	svc.HandleSessionDisconnect("rcv", "rcv-sess", false)
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

	svc.HandleSessionDisconnect("rcv", "rcv-sess", false)
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

	svc.HandleSessionDisconnect("rcv", "rcv-sess", false)

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

	svc.HandleSessionDisconnect("rcv", "some-other-device", false)

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

	svc.HandleSessionDisconnect("rcv", "rcv-sess", false) // the receiver is gone

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

	svc.HandleSessionDisconnect("rcv", "rcv-sess", false)
	svc.HandleSessionDisconnect("caller", "caller-sess", false)

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

	svc.HandleSessionDisconnect("rcv", "rcv-sess", false)
	svc.HandleSessionDisconnect("caller", "caller-sess", false)

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

	svc.HandleSessionDisconnect("caller", "caller-sess", false)

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

// An iOS reload: the old page's socket is gone and the new page is a different app. It hangs the
// answered call up in the old page's name; refusing it left the peer in a silent call.
func TestEnd_ByAReloadedPageInTheOldPagesNameHangsUp(t *testing.T) {
	svc, hub := activeCallService(time.Hour)
	svc.activeCalls["x"].ReceiverInstanceID = "old-page"
	svc.HandleSessionDisconnect("rcv", "rcv-sess", false)

	if err := svc.EndCall("rcv", "old-page", "phone-dev", "x"); err != nil {
		t.Fatalf("EndCall: %v", err)
	}
	if callExists(svc, "x") {
		t.Fatal("the call is still up")
	}
	if n := len(hub.eventsFor("caller", ws.OpP2PCallEnd)); n != 1 {
		t.Errorf("the caller was told %d times, want once", n)
	}
	svc.mu.RLock()
	left := len(svc.graceTimers)
	svc.mu.RUnlock()
	if left != 0 {
		t.Errorf("%d grace timers outlived the call", left)
	}
}

// An iOS app's page is suspended in the background while its native call media runs on; its
// socket dying is not the call dying. The 20 s window hung up every call locked for 2 minutes.
func TestNativeMediaOwner_KeepsTheCallPastTheGraceWindow(t *testing.T) {
	svc, hub := activeCallService(20 * time.Millisecond)

	svc.HandleSessionDisconnect("rcv", "rcv-sess", true)
	time.Sleep(80 * time.Millisecond)

	if !callExists(svc, "x") {
		t.Fatal("the call was ended while the iPhone's media was still running")
	}
	if n := len(hub.eventsFor("caller", ws.OpP2PCallEnd)); n != 0 {
		t.Errorf("the caller was told the call ended (%d)", n)
	}
	if err := svc.ResumeCall("rcv", "rcv-sess-2", "", "x"); err != nil {
		t.Fatalf("ResumeCall: %v", err)
	}
	svc.mu.RLock()
	left := len(svc.graceTimers) + len(svc.nativeAbsent)
	svc.mu.RUnlock()
	if left != 0 {
		t.Errorf("coming back left %d timers or marks", left)
	}
}

// The iOS app holding the call was killed and started again: a new instance on the same device.
// The old one cannot hold the media any more, so the call is released instead of keeping both
// users busy for hours.
func TestReleaseReplacedApp(t *testing.T) {
	cases := []struct {
		name         string
		native       bool
		instance     string
		device       string
		wantReleased bool
	}{
		{"the killed iOS app starts again", true, "app-2", "phone-dev", true},
		{"the same app coming back", true, "app-1", "phone-dev", false},
		{"another device of the user", true, "app-2", "tablet-dev", false},
		{"a second desktop window while the first is alive", false, "app-2", "phone-dev", false},
		{"a client with no instance id", true, "", "phone-dev", false},
	}
	for _, c := range cases {
		svc, hub := activeCallService(time.Hour)
		svc.activeCalls["x"].ReceiverInstanceID = "app-1"
		svc.activeCalls["x"].ReceiverDeviceID = "phone-dev"
		if c.native {
			svc.HandleSessionDisconnect("rcv", "rcv-sess", true)
		}

		svc.ReleaseReplacedApp("rcv", c.instance, c.device, "")

		if released := !callExists(svc, "x"); released != c.wantReleased {
			t.Errorf("%s: released = %v, want %v", c.name, released, c.wantReleased)
		}
		if c.wantReleased && len(hub.eventsFor("caller", ws.OpP2PCallEnd)) != 1 {
			t.Errorf("%s: the caller was not told", c.name)
		}
	}
}

// A page back from suspension replays hang-ups it may have written into a dead socket. For a
// call already over the server answers with its end, so the app can stop replaying.
func TestReplayedTeardownOfAnEndedCallIsSettled(t *testing.T) {
	for name, replay := range map[string]func(*p2pCallService) error{
		"end":     func(s *p2pCallService) error { return s.EndCall("rcv", "", "rcv-dev", "gone") },
		"decline": func(s *p2pCallService) error { return s.DeclineCall("rcv", "rcv-dev", "gone") },
	} {
		svc, hub := activeCallService(time.Hour)
		if err := replay(svc); err == nil {
			t.Fatalf("%s: a replay for a call that is over succeeded", name)
		}
		if !callExists(svc, "x") {
			t.Fatalf("%s: the replay ended the call the user is in now", name)
		}
		ends := hub.eventsFor("rcv", ws.OpP2PCallEnd)
		if len(ends) != 1 || ends[0].Data.(map[string]string)["call_id"] != "gone" {
			t.Errorf("%s: the replay was not settled: %v", name, ends)
		}
	}
}

// The caller cancelled in the instant the answer landed. Refusing the decline left the call up
// with the caller gone and the receiver waiting on an offer for a minute.
func TestCallerCancellingAnAnsweredCallHangsUp(t *testing.T) {
	svc, hub := activeCallService(time.Hour)

	if err := svc.DeclineCall("caller", "caller-dev", "x"); err != nil {
		t.Fatalf("DeclineCall: %v", err)
	}
	if callExists(svc, "x") {
		t.Fatal("the call is still up")
	}
	if n := len(hub.eventsFor("rcv", ws.OpP2PCallEnd)); n != 1 {
		t.Errorf("the receiver was told %d times, want once", n)
	}
}

// Only the web page died (memory pressure in the background); the call's native media runs on
// and the new page says it holds it. Releasing it would hang up a healthy call.
func TestReleaseReplacedApp_LeavesACallTheNewPageStillHolds(t *testing.T) {
	svc, _ := activeCallService(time.Hour)
	svc.activeCalls["x"].ReceiverInstanceID = "old-page"
	svc.activeCalls["x"].ReceiverDeviceID = "phone-dev"
	svc.HandleSessionDisconnect("rcv", "rcv-sess", true)

	svc.ReleaseReplacedApp("rcv", "new-page", "phone-dev", "x")

	if !callExists(svc, "x") {
		t.Fatal("a call whose media never stopped was released")
	}
}

func adoptableCall(t *testing.T) (*p2pCallService, *recordingHub) {
	t.Helper()
	svc, hub := activeCallService(time.Hour)
	svc.userGetter = fakeUserGetter{}
	svc.urlSigner = fakeURLSigner{}
	svc.activeCalls["x"].ReceiverInstanceID = "old-page"
	svc.activeCalls["x"].ReceiverDeviceID = "phone-dev"
	svc.activeCalls["x"].AcceptedAt = time.Now().Add(-time.Minute)
	svc.HandleSessionDisconnect("rcv", "rcv-sess", true)
	return svc, hub
}

// The reloaded page takes the call over: it becomes the owner, the away timer stops, and it gets
// what it needs to show the call again.
func TestAdoptCall_HandsTheReloadedPageTheCall(t *testing.T) {
	svc, hub := adoptableCall(t)

	if err := svc.AdoptCall("rcv", "new-sess", "new-page", "phone-dev", "x", "old-page"); err != nil {
		t.Fatalf("AdoptCall: %v", err)
	}
	call := svc.activeCalls["x"]
	if call.ReceiverSessionID != "new-sess" || call.ReceiverInstanceID != "new-page" {
		t.Errorf("owner is %q/%q, want new-sess/new-page", call.ReceiverSessionID, call.ReceiverInstanceID)
	}
	svc.mu.RLock()
	left := len(svc.graceTimers) + len(svc.nativeAbsent)
	svc.mu.RUnlock()
	if left != 0 {
		t.Errorf("the away timer outlived the adoption (%d)", left)
	}
	adopted := hub.eventsFor("rcv", ws.OpP2PCallAdopted)
	if len(adopted) != 1 {
		t.Fatalf("got %d adopted events, want 1", len(adopted))
	}
	bc := adopted[0].Data.(models.P2PCallBroadcast)
	if bc.ID != "x" || bc.AcceptedAt == nil || bc.AcceptedAt.IsZero() {
		t.Errorf("the page cannot rebuild the call from %+v", bc)
	}
	// A repeat (its answer was lost) is answered again, not refused.
	if err := svc.AdoptCall("rcv", "new-sess", "new-page", "phone-dev", "x", "old-page"); err != nil {
		t.Errorf("repeat AdoptCall: %v", err)
	}
}

func TestAdoptCall_RefusesAnythingElseAndSaysWhere(t *testing.T) {
	cases := []struct {
		name, call, previous, device string
		wantEnd                      bool
	}{
		{"a call that ended meanwhile", "gone", "old-page", "phone-dev", true},
		{"a page that did not run it", "x", "someone-else", "phone-dev", false},
		{"another device", "x", "old-page", "tablet-dev", false},
	}
	for _, c := range cases {
		svc, hub := adoptableCall(t)
		if err := svc.AdoptCall("rcv", "new-sess", "new-page", c.device, c.call, c.previous); err == nil {
			t.Errorf("%s: adopted", c.name)
		}
		if got := svc.activeCalls["x"].ReceiverInstanceID; got != "old-page" {
			t.Errorf("%s: owner moved to %q", c.name, got)
		}
		if c.wantEnd && len(hub.eventsFor("rcv", ws.OpP2PCallEnd)) != 1 {
			t.Errorf("%s: the page was not told the call is over", c.name)
		}
		if !c.wantEnd && len(hub.eventsFor("rcv", ws.OpP2PCallAccept)) != 1 {
			t.Errorf("%s: the page was not told who holds the call", c.name)
		}
	}
}
