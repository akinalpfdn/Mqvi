package ws

import (
	"encoding/json"
	"testing"
	"time"
)

// A graceful shutdown has to tell each connection it is going down BEFORE it closes the socket, so
// the client reconnects deliberately instead of discovering the drop on its own backoff.
//
// The ordering is the whole point and it is fragile: trySend refuses to enqueue once done is
// closed (it must never send on a channel being torn down). So if the close were moved ahead of
// the notify — the obvious "simplification" — the frame would silently never be enqueued and the
// feature would be dead with nothing to show for it. This asserts the frame is actually sitting in
// the send buffer, which only happens if the notify ran while done was still open.
func TestHubShutdown_NotifiesEachClientBeforeClosingIt(t *testing.T) {
	h := newHub()
	c := join(h, "u1", nil, nil)

	h.Shutdown()

	select {
	case data := <-c.send:
		var e Event
		if err := json.Unmarshal(data, &e); err != nil {
			t.Fatalf("the enqueued frame is not valid JSON: %v", err)
		}
		if e.Op != OpServerShutdown {
			t.Errorf("enqueued frame op = %q, want %q — the client was closed without being told", e.Op, OpServerShutdown)
		}
	default:
		t.Fatal("no shutdown frame was enqueued — the close ran before the notify, so the client never hears it")
	}

	select {
	case <-c.done:
	default:
		t.Error("the connection was not closed after shutdown")
	}

	if len(h.clients) != 0 || len(h.serverClients) != 0 {
		t.Errorf("hub maps not cleared after shutdown: clients=%d serverClients=%d", len(h.clients), len(h.serverClients))
	}
}

// A lagging client with a full send buffer must not hold up the shutdown of everyone else. trySend
// is non-blocking, so a full buffer is skipped, not waited on.
func TestHubShutdown_DoesNotBlockOnAClientWhoseBufferIsFull(t *testing.T) {
	h := newHub()
	full := join(h, "slow", nil, nil)
	for len(full.send) < cap(full.send) {
		full.send <- []byte("already queued")
	}

	done := make(chan struct{})
	go func() {
		h.Shutdown()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown blocked on a client whose send buffer was full")
	}

	select {
	case <-full.done:
	default:
		t.Error("the lagging client was not closed")
	}
}
