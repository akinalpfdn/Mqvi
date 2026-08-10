package ws

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// The hub decides who receives what. Every bug in here is silent in the same way: a message reaches
// someone it should not, or fails to reach someone it should, and nothing errors. The existing ws
// tests cover a single client's lifecycle; these cover the routing.

func newHub() *Hub {
	return &Hub{
		clients:        make(map[string]map[*Client]bool),
		serverClients:  make(map[string]map[*Client]bool),
		invisibleUsers: make(map[string]bool),
		unregister:     make(chan *Client, 64),
	}
}

// join registers one connection for a user in the given servers, the way addClient would.
func join(h *Hub, userID string, serverIDs ...string) *Client {
	c := &Client{
		userID:    userID,
		serverIDs: serverIDs,
		send:      make(chan []byte, 8),
		done:      make(chan struct{}),
		status:    "online",
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[userID] == nil {
		h.clients[userID] = make(map[*Client]bool)
	}
	h.clients[userID][c] = true
	for _, sid := range serverIDs {
		h.addClientToServerIndex(c, sid)
	}
	return c
}

// received drains a client's queue and returns the ops it got.
func received(c *Client) []string {
	var ops []string
	for {
		select {
		case data := <-c.send:
			var e Event
			if err := json.Unmarshal(data, &e); err != nil {
				return append(ops, "UNMARSHALABLE")
			}
			ops = append(ops, e.Op)
		default:
			return ops
		}
	}
}

func countReceived(c *Client) int { return len(received(c)) }

// ─── Server-scoped fan-out ───

// The isolation that matters most: servers are separate tenants as far as their members are
// concerned, and an event crossing between them leaks a private conversation.
func TestBroadcastToServer_NeverCrossesIntoAnotherServer(t *testing.T) {
	h := newHub()
	inA := join(h, "a-member", "server-a")
	inB := join(h, "b-member", "server-b")
	inBoth := join(h, "both", "server-a", "server-b")

	h.BroadcastToServer("server-a", Event{Op: OpMessageCreate})

	if got := countReceived(inA); got != 1 {
		t.Errorf("member of server-a got %d events, want 1", got)
	}
	if got := countReceived(inBoth); got != 1 {
		t.Errorf("member of both servers got %d events, want 1", got)
	}
	if got := countReceived(inB); got != 0 {
		t.Errorf("member of server-b got %d events from server-a — events must not cross servers", got)
	}
}

func TestBroadcastToServer_StampsTheServerID(t *testing.T) {
	h := newHub()
	c := join(h, "u1", "server-a")

	h.BroadcastToServer("server-a", Event{Op: OpMessageCreate})

	var e Event
	if err := json.Unmarshal(<-c.send, &e); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// The client routes cross-server notifications on this field; an unstamped event is delivered
	// to the right socket and then filed under the wrong server.
	if e.ServerID != "server-a" {
		t.Errorf("ServerID = %q, want server-a", e.ServerID)
	}
}

// The exclusion is by user, not by connection: the sender's other devices must be skipped too, or
// their own action echoes back to them.
func TestBroadcastToServerExcept_SkipsEveryConnectionOfTheExcludedUser(t *testing.T) {
	h := newHub()
	sender1 := join(h, "sender", "server-a")
	sender2 := join(h, "sender", "server-a") // second device
	other := join(h, "other", "server-a")

	h.BroadcastToServerExcept("server-a", "sender", Event{Op: OpMessageCreate})

	if got := countReceived(sender1) + countReceived(sender2); got != 0 {
		t.Errorf("the excluded user received %d events across their devices, want 0", got)
	}
	if got := countReceived(other); got != 1 {
		t.Errorf("the other member got %d events, want 1", got)
	}
}

func TestBroadcastToAllExcept_SkipsEveryConnectionOfTheExcludedUser(t *testing.T) {
	h := newHub()
	excluded1 := join(h, "excluded")
	excluded2 := join(h, "excluded")
	other := join(h, "other")

	h.BroadcastToAllExcept("excluded", Event{Op: OpPresence})

	if got := countReceived(excluded1) + countReceived(excluded2); got != 0 {
		t.Errorf("the excluded user received %d events, want 0", got)
	}
	if got := countReceived(other); got != 1 {
		t.Errorf("the other user got %d events, want 1", got)
	}
}

func TestBroadcastToUser_ReachesEveryDeviceAndNobodyElse(t *testing.T) {
	h := newHub()
	mine1 := join(h, "me")
	mine2 := join(h, "me")
	theirs := join(h, "them")

	h.BroadcastToUser("me", Event{Op: OpPresence})

	if got := countReceived(mine1); got != 1 {
		t.Errorf("device 1 got %d, want 1", got)
	}
	if got := countReceived(mine2); got != 1 {
		t.Errorf("device 2 got %d, want 1 — a user's other devices must stay in sync", got)
	}
	if got := countReceived(theirs); got != 0 {
		t.Errorf("an unrelated user got %d events, want 0", got)
	}
}

// ─── The server index ───

// serverClients is a denormalised copy of client.serverIDs. It is what makes BroadcastToServer
// O(server) instead of O(everyone), and it is only correct while the two agree — a stale entry
// keeps delivering a left server's events, a missing one silently drops a joined server's.

func TestAddClientServerID_StartsDeliveringTheNewServer(t *testing.T) {
	h := newHub()
	c := join(h, "u1")

	h.BroadcastToServer("server-new", Event{Op: OpMessageCreate})
	if got := countReceived(c); got != 0 {
		t.Fatalf("received %d events before joining", got)
	}

	h.AddClientServerID("u1", "server-new")
	h.BroadcastToServer("server-new", Event{Op: OpMessageCreate})

	if got := countReceived(c); got != 1 {
		t.Errorf("received %d events after joining, want 1", got)
	}
}

func TestRemoveClientServerID_StopsDeliveringThatServer(t *testing.T) {
	h := newHub()
	c := join(h, "u1", "server-a", "server-b")

	h.RemoveClientServerID("u1", "server-a")

	h.BroadcastToServer("server-a", Event{Op: OpMessageCreate})
	if got := countReceived(c); got != 0 {
		t.Errorf("still receiving server-a after leaving it: %d events", got)
	}
	// Leaving one server must not unsubscribe from the others.
	h.BroadcastToServer("server-b", Event{Op: OpMessageCreate})
	if got := countReceived(c); got != 1 {
		t.Errorf("server-b delivery broke when server-a was left: %d events, want 1", got)
	}
}

// Asserted against the index itself, not against delivery. removeClient closes the client, and a
// closed client swallows sends silently — so "it received nothing" holds whether or not the index
// was cleaned, and a test written that way passes over the leak. What actually rots is the index:
// dead entries accumulate and every later broadcast walks them.
func TestRemoveClient_ClearsTheServerIndex(t *testing.T) {
	h := newHub()
	leaving := join(h, "leaving", "server-a", "server-b")
	staying := join(h, "staying", "server-a")

	h.removeClient(leaving)

	h.mu.RLock()
	_, inA := h.serverClients["server-a"][leaving]
	_, inB := h.serverClients["server-b"][leaving]
	remaining := len(h.serverClients["server-a"])
	h.mu.RUnlock()

	if inA || inB {
		t.Errorf("the removed client is still indexed (server-a: %t, server-b: %t) — dead entries "+
			"accumulate and every broadcast walks them", inA, inB)
	}
	if remaining != 1 {
		t.Errorf("server-a index holds %d clients, want 1 (the one that stayed)", remaining)
	}

	// And the survivor is untouched.
	h.BroadcastToServer("server-a", Event{Op: OpMessageCreate})
	if got := countReceived(staying); got != 1 {
		t.Errorf("the remaining member got %d events, want 1", got)
	}
}

// The empty-set cleanup: the last member leaving must take the whole server key with it, or the map
// grows one permanent entry per server that ever had a connection.
func TestRemoveClient_DropsTheServerKeyWhenItsLastMemberLeaves(t *testing.T) {
	h := newHub()
	only := join(h, "only", "server-a")

	h.removeClient(only)

	h.mu.RLock()
	_, exists := h.serverClients["server-a"]
	h.mu.RUnlock()

	if exists {
		t.Error("an empty server kept its index entry — the map never shrinks")
	}
}

// ─── Connect / disconnect callback edges ───

// These two callbacks are what tell the rest of the system a user came online or went offline, and
// both are edge-triggered on purpose. Firing per connection instead of per user is not a subtle
// bug: opening a second tab would announce you as newly online, and closing it would announce you
// as offline while you are still sitting in the first one.
//
// They run on their own goroutines, so the test waits for them rather than assuming.

func waitFor(t *testing.T, ch <-chan string) (string, bool) {
	t.Helper()
	select {
	case v := <-ch:
		return v, true
	case <-time.After(time.Second):
		return "", false
	}
}

func expectQuiet(t *testing.T, ch <-chan string, what string) {
	t.Helper()
	select {
	case v := <-ch:
		t.Errorf("%s fired for %q when it should not have", what, v)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestAddClient_AnnouncesTheFirstConnectionOnly(t *testing.T) {
	h := newHub()
	fired := make(chan string, 4)
	h.onUserFirstConnect = func(userID, _ string) { fired <- userID }

	h.addClient(&Client{userID: "u1", send: make(chan []byte, 4), done: make(chan struct{})})
	if got, ok := waitFor(t, fired); !ok || got != "u1" {
		t.Fatalf("first connect did not announce: got %q ok=%t", got, ok)
	}

	// A second device is the same user arriving again, not a new arrival.
	h.addClient(&Client{userID: "u1", send: make(chan []byte, 4), done: make(chan struct{})})
	expectQuiet(t, fired, "onUserFirstConnect")
}

func TestRemoveClient_AnnouncesOnlyTheLastDisconnection(t *testing.T) {
	h := newHub()
	gone := make(chan string, 4)
	h.onUserFullyDisconnected = func(userID string, _ []string) { gone <- userID }

	first := join(h, "u1")
	second := join(h, "u1")

	h.removeClient(first)
	// Still on their other device: announcing them offline here is the bug this guards.
	expectQuiet(t, gone, "onUserFullyDisconnected")

	h.removeClient(second)
	if got, ok := waitFor(t, gone); !ok || got != "u1" {
		t.Fatalf("last disconnect did not announce: got %q ok=%t", got, ok)
	}
}

// ─── Aggregate presence ───

// A user is as active as their most active device: reading email on the laptop while the phone
// sits idle should not show them as idle.
func TestAggregateStatus_TakesTheMostActiveConnection(t *testing.T) {
	cases := []struct {
		name     string
		statuses []string
		want     string
	}{
		{"online beats idle", []string{"idle", "online"}, "online"},
		{"idle beats dnd", []string{"dnd", "idle"}, "idle"},
		{"dnd beats offline", []string{"offline", "dnd"}, "dnd"},
		{"all invisible stays offline", []string{"offline", "offline"}, "offline"},
		{"single connection is itself", []string{"dnd"}, "dnd"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHub()
			for _, s := range tc.statuses {
				join(h, "u1").status = s
			}

			h.mu.RLock()
			got := h.computeAggregateStatusLocked("u1")
			h.mu.RUnlock()

			if got != tc.want {
				t.Errorf("statuses %v aggregated to %q, want %q", tc.statuses, got, tc.want)
			}
		})
	}
}

func TestAggregateStatus_IsOfflineWhenNothingIsConnected(t *testing.T) {
	h := newHub()

	h.mu.RLock()
	got := h.computeAggregateStatusLocked("nobody")
	h.mu.RUnlock()

	if got != "offline" {
		t.Errorf("got %q for a user with no connections, want offline", got)
	}
}

// ─── Invisibility ───

// Two lists, two different jobs, and the difference is deliberate. GetVisibleAudienceFor feeds a
// client's online list, so it hides invisible users. GetOnlineUserIDs answers "does this user still
// hold a socket" for the voice orphan sweep — filtering there would make the sweep tear down the
// live voice state of anyone appearing offline.
func TestInvisibility_HiddenFromTheClientListButNotFromTheOrphanSweep(t *testing.T) {
	h := newHub()
	join(h, "lurker", "server-a")
	join(h, "watcher", "server-a")
	h.SetInvisible("lurker", true)

	visible := h.GetVisibleAudienceFor("watcher", []string{"server-a"}, nil)
	for _, id := range visible {
		if id == "lurker" {
			t.Error("an invisible user appeared in another user's online list")
		}
	}

	var stillConnected bool
	for _, id := range h.GetOnlineUserIDs() {
		if id == "lurker" {
			stillConnected = true
		}
	}
	if !stillConnected {
		t.Error("GetOnlineUserIDs dropped an invisible user — the voice orphan sweep would tear " +
			"down their live voice state")
	}
}

func TestSetInvisible_IsReversible(t *testing.T) {
	h := newHub()
	join(h, "lurker", "server-a")
	join(h, "watcher", "server-a")

	h.SetInvisible("lurker", true)
	h.SetInvisible("lurker", false)

	var found bool
	for _, id := range h.GetVisibleAudienceFor("watcher", []string{"server-a"}, nil) {
		if id == "lurker" {
			found = true
		}
	}
	if !found {
		t.Error("turning invisibility off did not put the user back in the online list")
	}
}

// ─── seq ───

// Every outbound event carries a monotonic seq. Nothing consumes it today — there is no replay
// buffer and the client never sends one back — but it is stamped from several broadcast paths at
// once, so a duplicate would mean the counter is not atomic.
func TestSeq_IsUniqueAcrossConcurrentBroadcasts(t *testing.T) {
	h := newHub()
	c := join(h, "u1", "server-a")
	// Wide enough that no send is dropped for a full buffer, which would hide a duplicate.
	c.send = make(chan []byte, 4096)

	const perPath = 200
	var wg sync.WaitGroup
	for _, broadcast := range []func(){
		func() { h.BroadcastToAll(Event{Op: OpPresence}) },
		func() { h.BroadcastToUser("u1", Event{Op: OpPresence}) },
		func() { h.BroadcastToServer("server-a", Event{Op: OpMessageCreate}) },
	} {
		wg.Add(1)
		go func(fn func()) {
			defer wg.Done()
			for i := 0; i < perPath; i++ {
				fn()
			}
		}(broadcast)
	}
	wg.Wait()

	seen := make(map[int64]bool)
	for {
		select {
		case data := <-c.send:
			var e Event
			if err := json.Unmarshal(data, &e); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if seen[e.Seq] {
				t.Fatalf("seq %d was handed out twice — the counter is not atomic", e.Seq)
			}
			seen[e.Seq] = true
		default:
			if len(seen) != perPath*3 {
				t.Fatalf("received %d events, want %d — some were dropped and a duplicate could hide",
					len(seen), perPath*3)
			}
			return
		}
	}
}

// ─── A client that stops reading ───

// A full buffer means the client is not draining. The broadcast must not block on it — one stuck
// socket would otherwise stall delivery for everyone — and the client is dropped instead.
func TestBroadcast_DropsAStuckClientInsteadOfBlocking(t *testing.T) {
	h := newHub()
	stuck := join(h, "stuck")
	healthy := join(h, "healthy")

	// Fill the stuck client's buffer.
	for i := 0; i < cap(stuck.send); i++ {
		stuck.send <- []byte("{}")
	}

	done := make(chan struct{})
	go func() {
		h.BroadcastToAll(Event{Op: OpPresence})
		close(done)
	}()

	select {
	case <-done:
	case <-h.unregister:
		t.Fatal("read the unregister channel before the broadcast returned")
	}

	if got := countReceived(healthy); got != 1 {
		t.Errorf("the healthy client got %d events, want 1 — one stuck socket stalled delivery", got)
	}
	// The stuck client is queued for removal on its own goroutine.
	select {
	case c := <-h.unregister:
		if c != stuck {
			t.Error("the wrong client was queued for removal")
		}
	default:
		t.Error("the stuck client was not queued for removal — it would stay and keep failing")
	}
}
