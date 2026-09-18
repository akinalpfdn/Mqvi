package ratelimit

import (
	"testing"
	"time"
)

// A rejected report (bad body, already pending) used to spend one of the five slots.
func TestMessageRateLimiter_RefundGivesTheSlotBack(t *testing.T) {
	rl := NewMessageRateLimiter(2, time.Minute, time.Minute)
	defer close(rl.stopCleanup)

	for i := 0; i < 5; i++ {
		if !rl.Allow("u") {
			t.Fatalf("attempt %d refused although every earlier one was refunded", i+1)
		}
		rl.Refund("u")
	}
	if !rl.Allow("u") || !rl.Allow("u") {
		t.Fatal("the two real slots should still be there")
	}
	if rl.Allow("u") {
		t.Fatal("a third use in the window should be refused")
	}
}

func TestMessageRateLimiter_RefundKeepsTheCooldown(t *testing.T) {
	rl := NewMessageRateLimiter(1, time.Minute, time.Minute)
	defer close(rl.stopCleanup)

	rl.Allow("u")
	rl.Allow("u") // refused: starts the cooldown
	rl.Refund("u")
	if rl.Allow("u") {
		t.Fatal("a refund must not lift a cooldown")
	}
}

func TestMessageRateLimiter_RefundForAnUnknownUserIsANoOp(t *testing.T) {
	rl := NewMessageRateLimiter(1, time.Minute, time.Minute)
	defer close(rl.stopCleanup)

	rl.Refund("nobody")
	if !rl.Allow("nobody") {
		t.Fatal("a stray refund must not change a fresh user's limit")
	}
}
