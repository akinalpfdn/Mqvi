package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type voipDevices map[string]bool

func (d voipDevices) HasVoIPToken(_ context.Context, _, deviceID string) bool { return d[deviceID] }

// The flag buys a four-hour away window for the call this socket carries. Taken on trust, any
// client could hold its answered call — and both users' "busy" state — open for hours.
func TestNativeMediaClaim(t *testing.T) {
	devices := voipDevices{"iphone": true}
	cases := []struct {
		name     string
		claimed  bool
		deviceID string
		checker  NativeDeviceChecker
		want     bool
	}{
		{"the iOS app that registered for CallKit", true, "iphone", devices, true},
		{"a browser claiming it", true, "laptop", devices, false},
		{"a claim with no device", true, "", devices, false},
		{"no claim", false, "iphone", devices, false},
		{"nothing to check it against", true, "laptop", nil, true},
	}
	for _, c := range cases {
		if got := nativeMediaClaim(context.Background(), c.claimed, "u1", c.deviceID, c.checker); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// Token registration and the WebSocket handshake run independently in the app. The verdict
// must reflect registration at disconnect, without trusting another device's claim.
func TestDisconnect_ChecksCurrentNativeMediaRegistration(t *testing.T) {
	for _, tc := range []struct {
		name             string
		claimed          bool
		registeredBefore bool
		registeredAfter  bool
		want             bool
	}{
		{"late registration", true, false, true, true},
		{"removed registration", true, true, false, false},
		{"unregistered claim", true, false, false, false},
		{"no claim", false, true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHub()
			// Exercise the real handshake, registering/removing its client synchronously so
			// the test does not leave Hub.Run's infinite loop behind.
			h.register = make(chan *Client, 1)
			h.unregister = make(chan *Client, 1)
			devices := &lateVoipDevice{}
			devices.registered.Store(tc.registeredBefore)
			handler := &Handler{hub: h, tokenValidator: stubTokenValidator{userID: "u1"}, nativeDevices: devices}
			result := make(chan bool, 1)
			h.OnSessionDisconnect(func(userID, sessionID string, native bool) {
				if userID != "u1" || sessionID == "" {
					t.Errorf("wrong owner: %s/%s", userID, sessionID)
				}
				result <- native
			})
			server := httptest.NewServer(http.HandlerFunc(handler.HandleConnection))
			defer server.Close()
			claim := "0"
			if tc.claimed {
				claim = "1"
			}
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?token=test&device_id=iphone&native_media="+claim, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			var client *Client
			select {
			case client = <-h.register:
			case <-time.After(time.Second):
				t.Fatal("client was not registered")
			}
			if !h.addClient(client) {
				t.Fatal("registration refused")
			}
			defer client.markClosed()
			devices.registered.Store(tc.registeredAfter)
			_ = conn.Close()
			select {
			case disconnected := <-h.unregister:
				h.removeClient(disconnected)
			case <-time.After(time.Second):
				t.Fatal("socket was not unregistered")
			}
			select {
			case got := <-result:
				if got != tc.want {
					t.Fatalf("native = %v, want %v", got, tc.want)
				}
			case <-time.After(time.Second):
				t.Fatal("disconnect callback did not complete")
			}
		})
	}
}

// Registration can complete on an HTTP goroutine while the WS handler is finishing.
type lateVoipDevice struct{ registered atomic.Bool }

func (d *lateVoipDevice) HasVoIPToken(_ context.Context, userID, deviceID string) bool {
	return userID == "u1" && deviceID == "iphone" && d.registered.Load()
}
