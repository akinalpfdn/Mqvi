package ratelimit

import (
	"testing"
	"time"
)

func TestTokenBucket_BurstThenThrottle(t *testing.T) {
	tb := NewTokenBucket(5, 10)
	base := time.Now()

	for i := 0; i < 5; i++ {
		if !tb.allowAt(base) {
			t.Fatalf("token %d within burst should be allowed", i)
		}
	}
	if tb.allowAt(base) {
		t.Fatal("6th token in the same instant should be throttled")
	}
}

func TestTokenBucket_RefillsOverTime(t *testing.T) {
	tb := NewTokenBucket(5, 10) // 10 tokens/sec
	base := time.Now()

	for i := 0; i < 5; i++ {
		tb.allowAt(base)
	}
	if tb.allowAt(base) {
		t.Fatal("bucket should be empty after the burst")
	}

	// 200ms later: 10/sec * 0.2s = 2 tokens refilled, no more.
	later := base.Add(200 * time.Millisecond)
	if !tb.allowAt(later) {
		t.Fatal("first refilled token should be allowed")
	}
	if !tb.allowAt(later) {
		t.Fatal("second refilled token should be allowed")
	}
	if tb.allowAt(later) {
		t.Fatal("only 2 tokens refilled — third should be throttled")
	}
}

func TestTokenBucket_RefillCappedAtCapacity(t *testing.T) {
	tb := NewTokenBucket(5, 10)
	base := time.Now()

	for i := 0; i < 5; i++ {
		tb.allowAt(base)
	}

	// A long idle must not accumulate tokens beyond capacity.
	later := base.Add(time.Hour)
	for i := 0; i < 5; i++ {
		if !tb.allowAt(later) {
			t.Fatalf("token %d after long idle should be allowed (capacity restored)", i)
		}
	}
	if tb.allowAt(later) {
		t.Fatal("refill must not exceed capacity")
	}
}
