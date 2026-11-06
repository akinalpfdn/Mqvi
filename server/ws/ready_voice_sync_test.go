package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

	// With hub set, ResyncVoiceSince stands in for the egress: it waits for the connection to be
	// registered and sends it a probe through the hub, so where the probe lands on the wire shows
	// where the handler asked for the repair.
	hub        *Hub
	registered chan struct{}
	mu         sync.Mutex
	resynced   map[string]uint64
}

var readMark = map[string]uint64{"s1": 7, "s2": 0}

func (v *visibleOnly) ReadyVoiceStates(_ context.Context, userID string, serverIDs []string) ([]models.VoiceState, map[string]int64, map[string]uint64) {
	v.askedUser, v.askedServers = userID, serverIDs
	return []models.VoiceState{{UserID: "u9", ChannelID: "open", ServerID: "s1"}}, map[string]int64{"open": 42}, readMark
}

func (v *visibleOnly) ResyncVoiceSince(userID string, mark map[string]uint64) {
	v.mu.Lock()
	v.resynced = mark
	v.mu.Unlock()
	if v.hub == nil {
		return
	}
	<-v.registered
	v.hub.BroadcastToUser(userID, Event{Op: "resync_probe"})
}

func (v *visibleOnly) resyncedMark() map[string]uint64 {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.resynced
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

// The connection is registered while the states are read, so a voice event queued after the read
// can reach it before the sync, which replaces everything and undoes it. The repair is asked for
// with the read's mark and only once the sync is queued, so it lands after it.
func TestReadyVoiceSync_RepairIsQueuedBehindTheSync(t *testing.T) {
	h := NewHub()
	h.register = make(chan *Client, 1)
	h.unregister = make(chan *Client, 1)
	provider := &visibleOnly{hub: h, registered: make(chan struct{})}
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
		close(provider.registered)
	case <-time.After(2 * time.Second):
		t.Fatal("client was not registered")
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var order []string
	for len(order) == 0 || order[len(order)-1] != "resync_probe" {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no resync probe after %v: %v", order, err)
		}
		for _, line := range strings.Split(string(raw), "\n") {
			var probe struct {
				Op string `json:"op"`
			}
			if json.Unmarshal([]byte(line), &probe) == nil && (probe.Op == OpVoiceStatesSync || probe.Op == "resync_probe") {
				order = append(order, probe.Op)
			}
		}
	}

	if strings.Join(order, ",") != OpVoiceStatesSync+",resync_probe" {
		t.Fatalf("wire order %v, want the sync first and the repair after it", order)
	}
	if got := provider.resyncedMark(); got["s1"] != 7 || got["s2"] != 0 || len(got) != 2 {
		t.Fatalf("repair asked with mark %v, want the read's %v", got, readMark)
	}
}
