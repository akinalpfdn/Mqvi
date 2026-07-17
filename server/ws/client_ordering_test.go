package ws

import (
	"sync"
	"testing"
	"time"
)

// S6 regression: a connection's inbound events must be handled in arrival order by a
// single worker (eventPump). A voice_join immediately followed by a voice_state_update
// must apply the join FULLY before the update runs — otherwise the update hits
// UpdateState's "no state yet" no-op and the mute/stream flag is silently dropped.
// The old code dispatched each event as `go c.hub.onVoiceX()`, so the two raced.
func TestClient_EventPump_JoinBeforeUpdate(t *testing.T) {
	var mu sync.Mutex
	var order []string

	joinStarted := make(chan struct{})
	releaseJoin := make(chan struct{})

	h := &Hub{unregister: make(chan *Client, 8)}
	h.onVoiceJoin = func(_, _, _, _, _ string, _, _ bool) {
		close(joinStarted)
		<-releaseJoin // hold the worker inside the join handler
		mu.Lock()
		order = append(order, "join")
		mu.Unlock()
	}
	h.onVoiceStateUpdate = func(_ string, _, _, _ *bool, _ *string) {
		mu.Lock()
		order = append(order, "update")
		mu.Unlock()
	}

	c := &Client{
		hub:    h,
		userID: "u1",
		events: make(chan Event, 8),
		done:   make(chan struct{}),
	}
	defer close(c.done)

	// Enqueue join then update (the exact S6 sequence).
	c.events <- Event{Op: OpVoiceJoin, Data: VoiceJoinData{ChannelID: "chan1"}}
	c.events <- Event{Op: OpVoiceStateUpdateReq, Data: VoiceStateUpdateRequestData{}}

	go c.eventPump()

	// Worker is now inside the join handler.
	<-joinStarted

	// While join is still running, the update must NOT have been processed —
	// this is the serialization guarantee that fixes the silent drop.
	mu.Lock()
	if len(order) != 0 {
		mu.Unlock()
		t.Fatalf("update ran before join completed: %v", order)
	}
	mu.Unlock()

	// Let join finish; the worker then processes the queued update.
	close(releaseJoin)

	deadline := time.After(2 * time.Second)
	for {
		mu.Lock()
		done := len(order) == 2
		mu.Unlock()
		if done {
			break
		}
		select {
		case <-deadline:
			mu.Lock()
			got := append([]string(nil), order...)
			mu.Unlock()
			t.Fatalf("timed out waiting for both handlers, got %v", got)
		default:
			time.Sleep(time.Millisecond)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if order[0] != "join" || order[1] != "update" {
		t.Fatalf("expected [join update], got %v", order)
	}
}

// enqueueEvent must never send on the events channel once the client is torn down
// (done closed) — the events channel is never closed, and this mirrors trySend's
// discipline. It also must not block ReadPump: a full queue on an open client
// returns false so the caller drops the connection instead of stalling.
func TestClient_EnqueueEvent_DoneAndFull(t *testing.T) {
	// Torn-down client: returns true (no-op), never blocks, never panics.
	c := &Client{events: make(chan Event), done: make(chan struct{})}
	close(c.done)
	if !c.enqueueEvent(Event{Op: OpTyping}) {
		t.Fatal("enqueue on a torn-down client should be a no-op returning true")
	}

	// Open client with a full queue: returns false (caller disconnects), no block.
	c2 := &Client{events: make(chan Event, 1), done: make(chan struct{})}
	if !c2.enqueueEvent(Event{Op: OpTyping}) {
		t.Fatal("first enqueue should succeed")
	}
	if c2.enqueueEvent(Event{Op: OpTyping}) {
		t.Fatal("enqueue on a full queue should return false")
	}
}
