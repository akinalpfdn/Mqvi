package ratelimit

import (
	"sync"
	"time"
)

// TokenBucket is a single-owner rate limiter: `capacity` tokens refilled at
// `refillPerSec`. Each Allow() consumes one token and returns false when empty.
//
// Unlike the map-based limiters in this package (keyed by IP/user), one TokenBucket
// belongs to a single caller — e.g. one WebSocket connection — so it needs no shared
// map and no cleanup goroutine: it is garbage-collected with its owner.
type TokenBucket struct {
	mu           sync.Mutex
	tokens       float64
	capacity     float64
	refillPerSec float64
	last         time.Time
}

// NewTokenBucket returns a bucket that starts full (capacity tokens) and refills at
// refillPerSec tokens/second. capacity is the burst size; refillPerSec is the sustained
// rate.
func NewTokenBucket(capacity int, refillPerSec float64) *TokenBucket {
	return &TokenBucket{
		tokens:       float64(capacity),
		capacity:     float64(capacity),
		refillPerSec: refillPerSec,
		last:         time.Now(),
	}
}

// Allow consumes one token, first refilling based on elapsed wall time.
func (tb *TokenBucket) Allow() bool {
	return tb.allowAt(time.Now())
}

// allowAt is the clock-injectable core, used by Allow and by tests for deterministic timing.
func (tb *TokenBucket) allowAt(now time.Time) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	if elapsed := now.Sub(tb.last).Seconds(); elapsed > 0 {
		tb.tokens += elapsed * tb.refillPerSec
		if tb.tokens > tb.capacity {
			tb.tokens = tb.capacity
		}
		tb.last = now
	}

	if tb.tokens < 1 {
		return false
	}
	tb.tokens--
	return true
}
