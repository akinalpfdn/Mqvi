package ws

import (
	"sync"
	"testing"
)

// K1 regression: concurrent sends (the sendEvent path is called UNLOCKED from ReadPump,
// e.g. a heartbeat ack) racing with the client being torn down must never panic with
// "send on closed channel". markClosed only closes `done` — the send channel is never
// closed — so a concurrent send can't panic. Run with -race.
func TestClient_ConcurrentSendAndClose_NoPanic(t *testing.T) {
	h := &Hub{unregister: make(chan *Client, 256)}

	// Drain unregister so the buffer-full path in sendEvent never blocks.
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-h.unregister:
			case <-stop:
				return
			}
		}
	}()

	c := &Client{
		hub:    h,
		userID: "u1",
		send:   make(chan []byte, 4), // small buffer so senders hit the full path too
		done:   make(chan struct{}),
	}

	var wg sync.WaitGroup

	// Many concurrent senders (mimics ReadPump heartbeat acks + hub broadcasts).
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 500; j++ {
				c.sendEvent(Event{Op: OpHeartbeatAck})
			}
		}()
	}

	// Concurrent teardown from two paths (removeClient + Shutdown) — must be idempotent.
	wg.Add(2)
	go func() { defer wg.Done(); c.markClosed() }()
	go func() { defer wg.Done(); c.markClosed() }()

	wg.Wait()
	close(stop)

	// done closed exactly once and observable.
	select {
	case <-c.done:
	default:
		t.Fatal("done should be closed after markClosed")
	}
}
