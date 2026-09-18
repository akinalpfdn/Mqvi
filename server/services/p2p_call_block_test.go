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

// blockedMidway answers the first friendship check as friends and every later one as blocked: the
// block lands between InitiateCall's first check and the moment the call is registered.
type blockedMidway struct{ calls int }

func (b *blockedMidway) GetByPair(_ context.Context, _, _ string) (*models.Friendship, error) {
	b.calls++
	if b.calls == 1 {
		return &models.Friendship{Status: models.FriendshipStatusAccepted}, nil
	}
	return &models.Friendship{Status: models.FriendshipStatusBlocked}, nil
}

// A block in that window found no call for EndCallBetween to end, and the blocked person rang.
// The call is checked again once registered, and dropped before anyone hears of it.
func TestInitiateCall_DropsACallBlockedBeforeItWasRegistered(t *testing.T) {
	hub := &recordingHub{}
	svc := &p2pCallService{
		friendChecker: &blockedMidway{},
		userGetter:    fakeUserGetter{},
		hub:           hub,
		activeCalls:   map[string]*models.P2PCall{},
		userCalls:     map[string]string{},
		ringTimers:    map[string]*time.Timer{},
	}

	err := svc.InitiateCall("alice", "alice-sess", "bob", models.P2PCallTypeVoice)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("want ErrForbidden, got %v", err)
	}
	if len(svc.activeCalls) != 0 || len(svc.userCalls) != 0 {
		t.Fatalf("the call was left registered: calls=%v users=%v", svc.activeCalls, svc.userCalls)
	}
	if len(svc.ringTimers) != 0 {
		t.Error("the ring timer was left running")
	}
	if len(hub.eventsFor("bob", ws.OpP2PCallInitiate)) != 0 {
		t.Error("the blocked user was rung")
	}
}
