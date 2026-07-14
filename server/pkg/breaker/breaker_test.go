package breaker

import (
	"testing"
	"time"
)

func TestBreakerOpensAfterThresholdFailures(t *testing.T) {
	b := New(3, time.Minute, time.Minute)

	for i := 0; i < 2; i++ {
		b.Record(false)
		if !b.Allow() {
			t.Fatalf("opened after %d failures, threshold is 3", i+1)
		}
	}
	b.Record(false)

	if b.Allow() {
		t.Error("still calling a dependency that failed 3 times in a row")
	}
}

func TestBreakerClosesAgainAfterTheOpenWindow(t *testing.T) {
	b := New(1, time.Minute, 20*time.Millisecond)
	b.Record(false)
	if b.Allow() {
		t.Fatal("did not open")
	}

	time.Sleep(30 * time.Millisecond)

	if !b.Allow() {
		t.Error("stayed open past its window — the outage is over, notifications are being dropped for nothing")
	}
}

// A dependency that answers is up. Holding the breaker half-open on stale failures would keep
// dropping pushes after FCM recovered.
func TestBreakerSuccessClearsAccumulatedFailures(t *testing.T) {
	b := New(3, time.Minute, time.Minute)
	b.Record(false)
	b.Record(false)
	b.Record(true)
	b.Record(false)
	b.Record(false)

	if !b.Allow() {
		t.Error("opened on 2 failures because a success in between did not reset the count")
	}
}

// Failures spread thinner than the window are noise, not an outage.
func TestBreakerForgetsFailuresOlderThanTheWindow(t *testing.T) {
	b := New(2, 20*time.Millisecond, time.Minute)
	b.Record(false)
	time.Sleep(30 * time.Millisecond)
	b.Record(false)

	if !b.Allow() {
		t.Error("opened on two failures 30ms apart in a 20ms window")
	}
}
