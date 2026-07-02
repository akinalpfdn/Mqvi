package ws

import (
	"testing"

	"github.com/akinalp/mqvi/pkg/ratelimit"
)

// B3 regression: heartbeat must never be throttled (throttling it would trip the
// pong-wait deadline and force false disconnects), and p2p_signal must draw from its own
// generous bucket so a chat-event flood can't starve call setup, and vice versa.
func TestClient_AllowEvent_HeartbeatExemptAndSignalIsolated(t *testing.T) {
	c := &Client{
		eventLimiter:  ratelimit.NewTokenBucket(1, 0), // 1 token, no refill
		signalLimiter: ratelimit.NewTokenBucket(1, 0),
	}

	// Drain the general bucket.
	if !c.allowEvent(OpTyping) {
		t.Fatal("first general event should be allowed")
	}
	if c.allowEvent(OpTyping) {
		t.Fatal("second general event should be throttled (bucket drained)")
	}

	// Heartbeat is exempt even with the general bucket empty.
	for i := 0; i < 5; i++ {
		if !c.allowEvent(OpHeartbeat) {
			t.Fatal("heartbeat must never be throttled")
		}
	}

	// Signaling has its own bucket, unaffected by the drained general bucket.
	if !c.allowEvent(OpP2PSignal) {
		t.Fatal("first signal should be allowed from its own bucket")
	}
	if c.allowEvent(OpP2PSignal) {
		t.Fatal("second signal should be throttled (signal bucket drained)")
	}
}

// A nil limiter (defensive: e.g. a Client built without wiring) must allow everything
// rather than panic — allowEvent is on the hot read path.
func TestClient_AllowEvent_NilLimiterAllows(t *testing.T) {
	c := &Client{}
	if !c.allowEvent(OpTyping) || !c.allowEvent(OpP2PSignal) || !c.allowEvent(OpHeartbeat) {
		t.Fatal("nil limiters should allow all events")
	}
}
