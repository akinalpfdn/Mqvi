package ws

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
)

func revocableClient(h *Hub, userID, authSessionID string) *Client {
	c := &Client{
		hub:           h,
		userID:        userID,
		authSessionID: authSessionID,
		send:          make(chan []byte, 4),
		done:          make(chan struct{}),
	}
	if h.clients[userID] == nil {
		h.clients[userID] = make(map[*Client]bool)
	}
	h.clients[userID][c] = true
	return c
}

// unregistered collects the clients the hub closes within the flush grace, plus slack.
func unregistered(h *Hub, want int) map[*Client]bool {
	got := map[*Client]bool{}
	deadline := time.After(serverShutdownGrace + time.Second)
	for len(got) < want {
		select {
		case c := <-h.unregister:
			got[c] = true
		case <-deadline:
			return got
		}
	}
	// Anything further would be a connection that should have stayed open.
	select {
	case c := <-h.unregister:
		got[c] = true
	case <-time.After(serverShutdownGrace + 100*time.Millisecond):
	}
	return got
}

func toldRevoked(t *testing.T, c *Client) bool {
	t.Helper()
	select {
	case data := <-c.send:
		var ev Event
		if err := json.Unmarshal(data, &ev); err != nil {
			t.Fatalf("frame: %v", err)
		}
		return ev.Op == OpSessionRevoked
	default:
		return false
	}
}

func TestHub_ShouldTellAndCloseOnlyTheRevokedSessionsConnections(t *testing.T) {
	h := NewHub()
	h.unregister = make(chan *Client, 8)
	phone := revocableClient(h, "u1", "s-phone")
	laptop := revocableClient(h, "u1", "s-laptop")
	stranger := revocableClient(h, "u2", "s-phone") // same id, other user: must not be touched

	h.RevokeAuthSessions("u1", []string{"s-phone"})

	closed := unregistered(h, 1)
	if !closed[phone] || len(closed) != 1 {
		t.Fatalf("closed %d connections, want only the phone", len(closed))
	}
	if !toldRevoked(t, phone) {
		t.Fatal("phone was not told it was signed out")
	}
	if toldRevoked(t, laptop) || toldRevoked(t, stranger) {
		t.Fatal("a connection outside the revoked session was told it was signed out")
	}
}

func TestHub_ShouldCloseEveryOtherConnectionIncludingUnnamedOnesWhenRevokingAllButOne(t *testing.T) {
	h := NewHub()
	h.unregister = make(chan *Client, 8)
	current := revocableClient(h, "u1", "s-current")
	other := revocableClient(h, "u1", "s-other")
	preSid := revocableClient(h, "u1", "") // token issued before sessions were named

	h.RevokeAuthSessionsExcept("u1", "s-current")

	closed := unregistered(h, 2)
	if !closed[other] || !closed[preSid] || closed[current] {
		t.Fatalf("closed other=%v preSid=%v current=%v", closed[other], closed[preSid], closed[current])
	}
}

// A password change replaces this device's session while its socket stays open; the socket must
// then count as the new session, or a later "sign out other devices" would close it.
func TestHub_ShouldTreatARetaggedConnectionAsItsNewSession(t *testing.T) {
	h := NewHub()
	h.unregister = make(chan *Client, 8)
	self := revocableClient(h, "u1", "s-old")
	other := revocableClient(h, "u1", "s-other")

	h.RetagAuthSession("u1", "s-old", "s-new")
	h.RevokeAuthSessionsExcept("u1", "s-new")

	closed := unregistered(h, 1)
	if !closed[other] || closed[self] {
		t.Fatalf("closed other=%v self=%v", closed[other], closed[self])
	}
}

func TestHub_ShouldSpareEverySessionItIsToldToKeep(t *testing.T) {
	h := NewHub()
	h.unregister = make(chan *Client, 8)
	oldSelf := revocableClient(h, "u1", "s-old")
	other := revocableClient(h, "u1", "s-other")

	h.RevokeAuthSessionsExcept("u1", "s-new", "s-old")

	closed := unregistered(h, 1)
	if !closed[other] || closed[oldSelf] {
		t.Fatalf("closed other=%v oldSelf=%v", closed[other], closed[oldSelf])
	}
}

type revokedSessionValidator struct{ stubTokenValidator }

func (revokedSessionValidator) ValidateSession(context.Context, *models.TokenClaims) error {
	return errors.New("session revoked")
}

// A signed-out device holds an unexpired access token; it must not be able to open a socket.
func TestHandleConnection_ShouldRefuseATokenWhoseSessionWasSignedOut(t *testing.T) {
	h := newHandlerUnderTest(t, 10, 100)
	h.tokenValidator = revokedSessionValidator{stubTokenValidator{userID: "u1"}}

	rec := connectOnce(h)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
}
