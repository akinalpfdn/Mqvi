package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/akinalp/mqvi/models"
)

type twoServers struct{}

func (twoServers) GetUserServers(context.Context, string) ([]models.ServerListItem, error) {
	return []models.ServerListItem{{ID: "s1"}, {ID: "s2"}}, nil
}

type plainSigner struct{}

func (plainSigner) SignURL(u string) string      { return u }
func (plainSigner) SignURLPtr(u *string) *string { return u }

// visibleOnly answers as the voice service would after filtering, and records who asked.
type visibleOnly struct {
	askedUser    string
	askedServers []string
}

func (v *visibleOnly) VisibleVoiceStates(_ context.Context, userID string, serverIDs []string) ([]models.VoiceState, map[string]int64) {
	v.askedUser, v.askedServers = userID, serverIDs
	return []models.VoiceState{{UserID: "u9", ChannelID: "open", ServerID: "s1"}}, map[string]int64{"open": 42}
}

// The ready sync used to send every voice state of the user's servers, hidden channels included.
// It must now carry exactly what the filtered source returns for this user and their servers.
func TestReadyVoiceSync_SendsOnlyWhatTheUserMaySee(t *testing.T) {
	h := NewHub()
	h.register = make(chan *Client, 1)
	h.unregister = make(chan *Client, 1)
	provider := &visibleOnly{}
	handler := &Handler{
		hub:                 h,
		tokenValidator:      stubTokenValidator{userID: "u1"},
		serverListProvider:  twoServers{},
		voiceStatesProvider: provider,
		urlSigner:           plainSigner{},
	}
	server := httptest.NewServer(http.HandlerFunc(handler.HandleConnection))
	defer server.Close()

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?token=test", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	select {
	case client := <-h.register:
		h.addClient(client)
		defer client.markClosed()
	case <-time.After(2 * time.Second):
		t.Fatal("client was not registered")
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var sync struct {
		Op string              `json:"op"`
		D  VoiceStatesSyncData `json:"d"`
	}
	for sync.Op != OpVoiceStatesSync {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no voice_states_sync: %v", err)
		}
		// A frame may batch several events; only the sync matters here.
		for _, line := range strings.Split(string(raw), "\n") {
			var probe struct {
				Op string `json:"op"`
			}
			if json.Unmarshal([]byte(line), &probe) == nil && probe.Op == OpVoiceStatesSync {
				if err := json.Unmarshal([]byte(line), &sync); err != nil {
					t.Fatalf("decode sync: %v", err)
				}
			}
		}
	}

	if provider.askedUser != "u1" || strings.Join(provider.askedServers, ",") != "s1,s2" {
		t.Fatalf("asked for user %q servers %v; want u1 and its servers s1,s2", provider.askedUser, provider.askedServers)
	}
	if len(sync.D.States) != 1 || sync.D.States[0].UserID != "u9" || sync.D.ChannelTimers["open"] != 42 || len(sync.D.ChannelTimers) != 1 {
		t.Fatalf("sync carried %+v; want exactly the filtered state and its timer", sync.D)
	}
}
