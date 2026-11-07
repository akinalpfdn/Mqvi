package ws

import (
	"sync"
	"testing"
	"time"
)

// A status the user picks belongs to the user, not to the device they picked it on: with the
// desktop and the phone both connected, the phone's own "online" must not overrule a DND set on the
// desktop. Only the automatic idle flag is per device. These rows are the state table the fix was
// written against.

// presenceLog records what the hub announced, in order. addClient and removeClient announce from
// their own goroutines, so the log is locked and waited on.
type presenceLog struct {
	mu   sync.Mutex
	seen []announced
	ch   chan announced
}

type announced struct {
	status, pref string
	auto         bool
}

func listen(h *Hub) *presenceLog {
	l := &presenceLog{ch: make(chan announced, 32)}
	h.OnPresenceManualUpdate(func(_ string, status, pref string, auto bool) {
		a := announced{status, pref, auto}
		l.mu.Lock()
		l.seen = append(l.seen, a)
		l.mu.Unlock()
		l.ch <- a
	})
	return l
}

// next waits for the next announcement.
func (l *presenceLog) next(t *testing.T) announced {
	t.Helper()
	select {
	case a := <-l.ch:
		return a
	case <-time.After(time.Second):
		t.Fatal("no presence announcement")
		return announced{}
	}
}

// connect registers a connection the way the handler does, with the pref_status read from the DB.
func connect(t *testing.T, h *Hub, l *presenceLog, pref string) *Client {
	t.Helper()
	c := &Client{hub: h, userID: "u1", prefStatus: pref, send: make(chan []byte, 8), done: make(chan struct{})}
	first := len(h.clients["u1"]) == 0
	if !h.addClient(c) {
		t.Fatal("connection refused")
	}
	if !first {
		l.next(t) // a later connection re-announces the aggregate
	}
	return c
}

func (c *Client) pick(status string) { c.sendPresence(status, false) }
func (c *Client) autoIdle()          { c.sendPresence("idle", true) }
func (c *Client) autoActive()        { c.sendPresence("online", true) }

func (c *Client) sendPresence(status string, auto bool) {
	c.handlePresenceUpdate(Event{Op: OpPresenceUpdate, Data: PresenceData{Status: status, IsAuto: auto}})
}

func TestPresence_APickedStatusHoldsAcrossTheUsersOtherDevices(t *testing.T) {
	cases := []struct {
		name  string
		setup func(a, b *Client, l *presenceLog, t *testing.T)
		act   func(a, b *Client)
		want  string
	}{
		{"DND picked while the other device is online", nil, func(a, _ *Client) { a.pick("dnd") }, "dnd"},
		{"DND picked while the other device is auto-idle",
			func(_, b *Client, l *presenceLog, t *testing.T) { b.autoIdle(); l.next(t) },
			func(a, _ *Client) { a.pick("dnd") }, "dnd"},
		{"invisible picked while the other device is online", nil, func(a, _ *Client) { a.pick("offline") }, "offline"},
		{"idle picked while the other device is online", nil, func(a, _ *Client) { a.pick("idle") }, "idle"},
		{"the other device's auto-idle does not override a picked DND",
			func(a, _ *Client, l *presenceLog, t *testing.T) { a.pick("dnd"); l.next(t) },
			func(_, b *Client) { b.autoIdle() }, "dnd"},
		{"picking online on an auto-idle device makes the user online",
			func(a, b *Client, l *presenceLog, t *testing.T) { a.autoIdle(); l.next(t); b.autoIdle(); l.next(t) },
			func(a, _ *Client) { a.pick("online") }, "online"},
		{"one active device keeps the user online",
			func(a, _ *Client, l *presenceLog, t *testing.T) { a.autoIdle(); l.next(t) },
			func(_, b *Client) { b.autoActive() }, "online"},
		{"every device auto-idle makes the user idle",
			func(a, _ *Client, l *presenceLog, t *testing.T) { a.autoIdle(); l.next(t) },
			func(_, b *Client) { b.autoIdle() }, "idle"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHub()
			l := listen(h)
			a := connect(t, h, l, "online")
			b := connect(t, h, l, "online")
			if tc.setup != nil {
				tc.setup(a, b, l, t)
			}

			tc.act(a, b)

			if got := l.next(t); got.status != tc.want {
				t.Fatalf("announced %q, want %q", got.status, tc.want)
			}
		})
	}
}

// What gets persisted as pref_status is the pick itself, never a fold of the devices.
func TestPresence_APickIsPersistedAsItselfAndAnnouncedWithIt(t *testing.T) {
	h := newHub()
	l := listen(h)
	a := connect(t, h, l, "online")
	b := connect(t, h, l, "online")
	b.autoIdle()
	l.next(t)

	a.pick("dnd")

	if got := l.next(t); got != (announced{status: "dnd", pref: "dnd", auto: false}) {
		t.Fatalf("announced %+v, want dnd persisted as dnd", got)
	}
}

func TestPresence_APickSurvivesTheDeviceItWasMadeOnDisconnecting(t *testing.T) {
	h := newHub()
	l := listen(h)
	a := connect(t, h, l, "online")
	connect(t, h, l, "online")
	a.pick("dnd")
	l.next(t)

	h.removeClient(a)

	if got := l.next(t); got.status != "dnd" {
		t.Fatalf("after the picking device left the user is %q, want dnd", got.status)
	}
}

func TestPresence_ALaterDeviceJoinsUnderThePickedStatus(t *testing.T) {
	h := newHub()
	l := listen(h)
	a := connect(t, h, l, "online")
	a.pick("dnd")
	l.next(t)

	// Its handshake read pref_status before the pick reached the database.
	if !h.addClient(&Client{hub: h, userID: "u1", prefStatus: "online", send: make(chan []byte, 8), done: make(chan struct{})}) {
		t.Fatal("connection refused")
	}

	if got := l.next(t); got.status != "dnd" {
		t.Fatalf("a second device made the user %q, want dnd", got.status)
	}
}

func TestPresence_ANewSessionStartsFromThePersistedPick(t *testing.T) {
	h := newHub()
	l := listen(h)
	a := connect(t, h, l, "online")
	a.pick("dnd")
	l.next(t)
	h.removeClient(a)

	c := connect(t, h, l, "idle")
	c.autoActive()

	if got := l.next(t); got.status != "idle" {
		t.Fatalf("a fresh session announced %q, want the persisted idle", got.status)
	}
}
