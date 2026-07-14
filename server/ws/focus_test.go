package ws

import (
	"testing"
	"time"
)

// focusedClient builds a client claiming to show views, last seen alive `age` ago.
// Online unless a test says otherwise — an idle session never suppresses (see below).
func focusedClient(focused bool, age time.Duration, views ...string) *Client {
	c := &Client{focused: focused, status: "online", focusViews: map[string]bool{}}
	for _, v := range views {
		c.focusViews[v] = true
	}
	c.focusAt.Store(time.Now().Add(-age).UnixNano())
	return c
}

func hubWithClients(userID string, clients ...*Client) *Hub {
	h := &Hub{clients: map[string]map[*Client]bool{userID: {}}}
	for _, c := range clients {
		h.clients[userID][c] = true
	}
	return h
}

// HasFocusedViewer decides whether a DM push is redundant. Getting it wrong in the
// permissive direction is not a cosmetic bug: it silently swallows the notification.
func TestHasFocusedViewer(t *testing.T) {
	dmKey := focusKey(FocusViewDM, "dm1")

	cases := []struct {
		name   string
		client *Client
		want   bool
	}{
		{
			name:   "reading this DM right now",
			client: focusedClient(true, time.Second, dmKey),
			want:   true,
		},
		{
			name:   "focused on a different DM",
			client: focusedClient(true, time.Second, focusKey(FocusViewDM, "dm2")),
			want:   false,
		},
		{
			name:   "focused on a channel of the same id",
			client: focusedClient(true, time.Second, focusKey(FocusViewChannel, "dm1")),
			want:   false,
		},
		{
			// The regression this whole design exists to avoid. A backgrounded phone keeps
			// its WebSocket, so anything keying off "is the connection there" suppresses the
			// push exactly when the user needs it. Focus must be the thing that decides.
			name:   "backgrounded with the DM still open",
			client: focusedClient(false, time.Second, dmKey),
			want:   false,
		},
		{
			// Sleeping laptop / phone off the network: the socket lingers half-open until the
			// 90s pong deadline, still claiming to be reading. Its claim has to expire first.
			name:   "focus claim older than the liveness window",
			client: focusedClient(true, focusTTL+time.Second, dmKey),
			want:   false,
		},
		{
			name:   "focus claim just inside the liveness window",
			client: focusedClient(true, focusTTL-5*time.Second, dmKey),
			want:   true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := hubWithClients("u1", tc.client)
			if got := h.HasFocusedViewer("u1", FocusViewDM, "dm1"); got != tc.want {
				t.Errorf("HasFocusedViewer = %v, want %v", got, tc.want)
			}
		})
	}
}

// Any one live focused device is enough — the user has the chat in front of them.
func TestHasFocusedViewerAcrossDevices(t *testing.T) {
	dmKey := focusKey(FocusViewDM, "dm1")
	phone := focusedClient(false, time.Second, dmKey)                          // backgrounded
	desktop := focusedClient(true, time.Second, focusKey(FocusViewDM, "dm2"))  // elsewhere
	laptop := focusedClient(true, time.Second, dmKey)                          // reading it

	if h := hubWithClients("u1", phone, desktop); h.HasFocusedViewer("u1", FocusViewDM, "dm1") {
		t.Error("no device is reading dm1 — the push must go out")
	}
	if h := hubWithClients("u1", phone, desktop, laptop); !h.HasFocusedViewer("u1", FocusViewDM, "dm1") {
		t.Error("a device IS reading dm1 — the push is redundant")
	}
}

func TestHasFocusedViewerUnknownUser(t *testing.T) {
	h := hubWithClients("u1", focusedClient(true, time.Second, focusKey(FocusViewDM, "dm1")))
	if h.HasFocusedViewer("someone-else", FocusViewDM, "dm1") {
		t.Error("another user's focus must never suppress this user's push")
	}
	if h.HasFocusedViewer("u1", FocusViewDM, "") {
		t.Error("an empty view id must not match anything")
	}
}

// A window focused on a DM with nobody in front of it is a laptop left open at lunch.
// Presence already knows this — the connection goes "idle" after inactivity — so an idle
// session's claim must be ignored. Without this the user gets NO phone notification for that
// conversation for as long as the laptop stays open, which is a worse bug than the one the
// focus gate was built to fix.
func TestHasFocusedViewer_IgnoresIdleAndAwayStatus(t *testing.T) {
	dm := focusKey(FocusViewDM, "dm1")

	for _, status := range []string{"idle", "dnd", "offline"} {
		t.Run(status, func(t *testing.T) {
			c := focusedClient(true, time.Second, dm)
			c.status = status
			h := hubWithClients("u1", c)
			if h.HasFocusedViewer("u1", FocusViewDM, "dm1") {
				t.Errorf("a %q session claimed to be reading the chat — nobody is there, the push must go out", status)
			}
		})
	}

	online := focusedClient(true, time.Second, dm)
	online.status = "online"
	if h := hubWithClients("u1", online); !h.HasFocusedViewer("u1", FocusViewDM, "dm1") {
		t.Error("an online, focused session IS reading the chat — the push is redundant")
	}
}
