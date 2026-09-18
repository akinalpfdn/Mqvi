package services

import (
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/ws"
)

// Blocking someone has to end a call with them. A new call needs a friendship the block deletes,
// but a call already ringing or running went on: its media is peer to peer and never touches the
// server again, so the blocked person could keep talking.
func TestEndCallBetween(t *testing.T) {
	newSvc := func(status models.P2PCallStatus) (*p2pCallService, *recordingHub) {
		hub := &recordingHub{}
		return &p2pCallService{
			hub:         hub,
			activeCalls: map[string]*models.P2PCall{"x": {ID: "x", CallerID: "alice", ReceiverID: "bob", Status: status}},
			userCalls:   map[string]string{"alice": "x", "bob": "x"},
			ringTimers:  map[string]*time.Timer{"x": time.AfterFunc(time.Hour, func() {})},
		}, hub
	}

	t.Run("should end an active call with the blocked user and tell both", func(t *testing.T) {
		svc, hub := newSvc(models.P2PCallStatusActive)
		svc.EndCallBetween("alice", "bob")

		if _, ok := svc.activeCalls["x"]; ok {
			t.Fatal("the call survived the block")
		}
		if _, ok := svc.userCalls["bob"]; ok {
			t.Error("the blocked user is still marked as in the call")
		}
		for _, user := range []string{"alice", "bob"} {
			if len(hub.eventsFor(user, ws.OpP2PCallEnd)) != 1 {
				t.Errorf("%s was not told the call ended", user)
			}
		}
	})

	t.Run("should end a call still ringing, whichever side blocks", func(t *testing.T) {
		svc, _ := newSvc(models.P2PCallStatusRinging)
		svc.EndCallBetween("bob", "alice") // the receiver blocks the caller mid-ring
		if _, ok := svc.activeCalls["x"]; ok {
			t.Fatal("the ringing call survived the block")
		}
	})

	t.Run("should leave a call with someone else alone", func(t *testing.T) {
		svc, hub := newSvc(models.P2PCallStatusActive)
		svc.EndCallBetween("alice", "carol")
		if _, ok := svc.activeCalls["x"]; !ok {
			t.Fatal("blocking a third person ended an unrelated call")
		}
		if len(hub.eventsFor("bob", ws.OpP2PCallEnd)) != 0 {
			t.Error("the other party was told an unrelated call ended")
		}
	})

	t.Run("should do nothing for a user in no call", func(t *testing.T) {
		svc, _ := newSvc(models.P2PCallStatusActive)
		svc.EndCallBetween("dave", "alice")
		if _, ok := svc.activeCalls["x"]; !ok {
			t.Fatal("a user in no call ended someone else's")
		}
	})
}
