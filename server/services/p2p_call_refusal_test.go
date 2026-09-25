package services

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

type friendAnswer struct {
	f   *models.Friendship
	err error
}

// scriptedFriends answers each GetByPair in turn; the last answer repeats.
type scriptedFriends struct {
	answers []friendAnswer
	calls   int
}

func (s *scriptedFriends) GetByPair(_ context.Context, _, _ string) (*models.Friendship, error) {
	a := s.answers[min(s.calls, len(s.answers)-1)]
	s.calls++
	return a.f, a.err
}

// receiverLookup fails the receiver's active-user lookup with err.
type receiverLookup struct{ err error }

func (g receiverLookup) GetByID(_ context.Context, id string) (*models.User, error) {
	return &models.User{ID: id}, nil
}

func (g receiverLookup) GetActiveByID(_ context.Context, id string) (*models.User, error) {
	if id == "receiver" && g.err != nil {
		return nil, g.err
	}
	return &models.User{ID: id}, nil
}

func TestInitiateCall_TellsTheCallerWhyNoCallStarted(t *testing.T) {
	accepted := friendAnswer{f: &models.Friendship{Status: models.FriendshipStatusAccepted}}
	blocked := friendAnswer{f: &models.Friendship{Status: models.FriendshipStatusBlocked}}
	noRow := friendAnswer{err: fmt.Errorf("%w: friendship", pkg.ErrNotFound)}
	dbDown := errors.New("database is locked")

	cases := []struct {
		name      string
		friends   []friendAnswer
		receiver  error
		userCalls map[string]string
		want      string
	}{
		{"no friendship", []friendAnswer{noRow}, nil, nil, ws.P2PCallRefusedNotFriends},
		{"a pending request is not a friendship", []friendAnswer{{f: &models.Friendship{Status: models.FriendshipStatusPending}}}, nil, nil, ws.P2PCallRefusedNotFriends},
		{"a block reads as not friends, never as a block", []friendAnswer{blocked}, nil, nil, ws.P2PCallRefusedNotFriends},
		{"blocked between the check and the registration", []friendAnswer{accepted, blocked}, nil, nil, ws.P2PCallRefusedNotFriends},
		{"deleted receiver", []friendAnswer{accepted}, pkg.ErrNotFound, nil, ws.P2PCallRefusedUnavailable},
		{"caller already in a call", []friendAnswer{accepted}, nil, map[string]string{"caller": "other"}, ws.P2PCallRefusedInCall},
		{"a busy receiver has its own event", []friendAnswer{accepted}, nil, map[string]string{"receiver": "other"}, ""},
		// A failed lookup is no answer: "not friends" or "unavailable" here would tell the caller something untrue.
		{"friendship lookup failed", []friendAnswer{{err: dbDown}}, nil, nil, ws.P2PCallRefusedFailed},
		{"friendship recheck failed", []friendAnswer{accepted, {err: dbDown}}, nil, nil, ws.P2PCallRefusedFailed},
		{"receiver lookup failed", []friendAnswer{accepted}, dbDown, nil, ws.P2PCallRefusedFailed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			userCalls := c.userCalls
			if userCalls == nil {
				userCalls = map[string]string{}
			}
			svc := &p2pCallService{
				friendChecker: &scriptedFriends{answers: c.friends},
				userGetter:    receiverLookup{err: c.receiver},
				hub:           fakeHub{},
				activeCalls:   map[string]*models.P2PCall{},
				userCalls:     userCalls,
				ringTimers:    map[string]*time.Timer{},
			}

			err := svc.InitiateCall("caller", "caller-sess", "", "", "receiver", models.P2PCallTypeVoice)
			if err == nil {
				t.Fatal("a call started")
			}
			if got := CallRefusal(err); got != c.want {
				t.Errorf("CallRefusal = %q, want %q (err: %v)", got, c.want, err)
			}
		})
	}

	if got := CallRefusal(nil); got != "" {
		t.Errorf("a call that started reported %q", got)
	}
}
