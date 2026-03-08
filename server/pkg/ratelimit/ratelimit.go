// Package ratelimit provides IP-based login rate limiting
// and user-based message rate limiting.
package ratelimit

import (
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

type bucket struct {
	count       int
	windowStart time.Time
}

// LoginRateLimiter implements sliding-window rate limiting per IP address.
type LoginRateLimiter struct {
	mu          sync.RWMutex
	buckets     map[string]*bucket
	maxAttempts int
	window      time.Duration
	stopCleanup chan struct{}
}

func NewLoginRateLimiter(maxAttempts int, window time.Duration) *LoginRateLimiter {
	rl := &LoginRateLimiter{
		buckets:     make(map[string]*bucket),
		maxAttempts: maxAttempts,
		window:      window,
		stopCleanup: make(chan struct{}),
	}

	go rl.cleanupLoop()

	return rl
}

// Allow checks if a login attempt is permitted. Each call increments the counter.
// Call Reset() after successful login to clear the counter.
func (rl *LoginRateLimiter) Allow(ip string) bool {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[ip]
	if !exists {
		rl.buckets[ip] = &bucket{count: 1, windowStart: now}
		return true
	}

	if now.Sub(b.windowStart) > rl.window {
		b.count = 1
		b.windowStart = now
		return true
	}

	b.count++
	return b.count <= rl.maxAttempts
}

// Reset clears the counter after a successful login.
func (rl *LoginRateLimiter) Reset(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.buckets, ip)
}

// RetryAfterSeconds returns the remaining wait time for the Retry-After header.
func (rl *LoginRateLimiter) RetryAfterSeconds(ip string) int {
	rl.mu.RLock()
	defer rl.mu.RUnlock()

	b, exists := rl.buckets[ip]
	if !exists {
		return 0
	}

	remaining := rl.window - time.Since(b.windowStart)
	if remaining < 0 {
		return 0
	}
	seconds := int(remaining.Seconds()) + 1
	return seconds
}

func (rl *LoginRateLimiter) cleanupLoop() {
	ticker := time.NewTicker(60 * time.Second)
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

func (rl *LoginRateLimiter) cleanup() {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	for ip, b := range rl.buckets {
		if now.Sub(b.windowStart) > rl.window {
			delete(rl.buckets, ip)
		}
	}
}

// ExtractIP returns the client IP from the request.
// Checks X-Forwarded-For, X-Real-IP, then falls back to RemoteAddr.
func ExtractIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for i := 0; i < len(xff); i++ {
			if xff[i] == ',' {
				return xff[:i]
			}
		}
		return xff
	}

	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func FormatRetryMessage(seconds int) string {
	if seconds >= 60 {
		minutes := seconds / 60
		return fmt.Sprintf("%d minute(s)", minutes)
	}
	return fmt.Sprintf("%d second(s)", seconds)
}
