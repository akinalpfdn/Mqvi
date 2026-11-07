package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/akinalp/mqvi/models"
)

// staleNameToken was issued before the account was renamed; the access token outlives a rename by
// up to its TTL.
type staleNameToken struct{}

func (staleNameToken) ValidateAccessToken(string) (*models.TokenClaims, error) {
	return &models.TokenClaims{UserID: "u1", Username: "old_name"}, nil
}

func (staleNameToken) ValidateSession(context.Context, *models.TokenClaims) error { return nil }

type renamedUser struct{}

func (renamedUser) GetByID(context.Context, string) (*models.User, error) {
	display, avatar := "New Name", "/api/files/avatars/u1/new.png"
	return &models.User{ID: "u1", Username: "new_name", DisplayName: &display, AvatarURL: &avatar}, nil
}

// Typing and voice events carry the profile cached here, so it must be the account's current one —
// a reconnect after a rename used to bring the old username back from the token.
func TestHandleConnection_CachesTheProfileFromTheAccountNotTheToken(t *testing.T) {
	h := NewHub()
	h.register = make(chan *Client, 1)
	h.unregister = make(chan *Client, 1)
	handler := &Handler{hub: h, tokenValidator: staleNameToken{}, userInfoProvider: renamedUser{}, urlSigner: plainSigner{}}
	server := httptest.NewServer(http.HandlerFunc(handler.HandleConnection))
	defer server.Close()

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?token=test", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	select {
	case client := <-h.register:
		defer client.markClosed()
	case <-time.After(2 * time.Second):
		t.Fatal("client was not registered")
	}

	want := cachedUserInfo{Username: "new_name", DisplayName: "New Name", AvatarURL: "/api/files/avatars/u1/new.png"}
	if got := h.getUserInfo("u1"); got != want {
		t.Fatalf("cached %+v, want %+v", got, want)
	}
}
