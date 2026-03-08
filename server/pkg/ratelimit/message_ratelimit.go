// MessageRateLimiter provides per-user message spam protection.
//
// Differs from LoginRateLimiter:
//   - Keyed by userID (not IP) since the endpoint is authenticated.
//   - Separate cooldown period: when the limit is exceeded, the user must
//     wait for the cooldown duration (e.g. 15s) before sending again.
package ratelimit

import (
	"sync"
	"time"
)

type messageBucket struct {
	count         int
	windowStart   time.Time
	cooldownUntil time.Time // zero = no cooldown
}

type MessageRateLimiter struct {
	mu          sync.RWMutex
	buckets     map[string]*messageBucket
	maxMessages int
	window      time.Duration
	cooldown    time.Duration
	stopCleanup chan struct{}
}

func NewMessageRateLimiter(maxMessages int, window, cooldown time.Duration) *MessageRateLimiter {
	rl := &MessageRateLimiter{
		buckets:     make(map[string]*messageBucket),
		maxMessages: maxMessages,
		window:      window,
		cooldown:    cooldown,
		stopCleanup: make(chan struct{}),
	}

	go rl.cleanupLoop()

	return rl
}

// Allow checks if the user can send a message.
// Flow: cooldown active → reject; window expired → reset; within window → count++.
func (rl *MessageRateLimiter) Allow(userID string) bool {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[userID]
	if !exists {
		rl.buckets[userID] = &messageBucket{count: 1, windowStart: now}
		return true
	}

	// Still in cooldown?
	if !b.cooldownUntil.IsZero() && now.Before(b.cooldownUntil) {
		return false
	}

	// Cooldown expired — start new window
	if !b.cooldownUntil.IsZero() {
		b.count = 1
		b.windowStart = now
		b.cooldownUntil = time.Time{}
		return true
	}

	// Window expired — start new window
	if now.Sub(b.windowStart) > rl.window {
		b.count = 1
		b.windowStart = now
		return true
	}

	b.count++
	if b.count > rl.maxMessages {
		b.cooldownUntil = now.Add(rl.cooldown)
		return false
	}

	return true
}

// CooldownSeconds returns the remaining cooldown in seconds for the Retry-After header.
func (rl *MessageRateLimiter) CooldownSeconds(userID string) int {
	rl.mu.RLock()
	defer rl.mu.RUnlock()

	b, exists := rl.buckets[userID]
	if !exists {
		return 0
	}

	if b.cooldownUntil.IsZero() {
		return 0
	}

	remaining := time.Until(b.cooldownUntil)
	if remaining <= 0 {
		return 0
	}

	return int(remaining.Seconds()) + 1
}

func (rl *MessageRateLimiter) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.cleanup()
		case <-rl.stopCleanup:
			return
		}
	}
}

// cleanup removes buckets where both the window and cooldown have expired.
func (rl *MessageRateLimiter) cleanup() {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	for userID, b := range rl.buckets {
		windowExpired := now.Sub(b.windowStart) > rl.window
		cooldownExpired := b.cooldownUntil.IsZero() || now.After(b.cooldownUntil)

		if windowExpired && cooldownExpired {
			delete(rl.buckets, userID)
		}
	}
}
