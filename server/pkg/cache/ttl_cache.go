// Package cache provides a generic in-memory TTL cache.
package cache

import (
	"sync"
	"time"
)

type entry[V any] struct {
	value     V
	expiresAt time.Time
}

// TTLCache is a thread-safe, generic cache with per-entry expiration.
type TTLCache[K comparable, V any] struct {
	mu      sync.RWMutex
	entries map[K]entry[V]
	ttl     time.Duration

	stopCleanup chan struct{}
}

// New creates a TTLCache and starts a background goroutine for eviction.
//
// cleanupInterval controls how often expired entries are physically removed
// from the map to prevent memory leaks.
func New[K comparable, V any](ttl, cleanupInterval time.Duration) *TTLCache[K, V] {
	c := &TTLCache[K, V]{
		entries:     make(map[K]entry[V]),
		ttl:         ttl,
		stopCleanup: make(chan struct{}),
	}

	go func() {
		ticker := time.NewTicker(cleanupInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				c.evictExpired()
			case <-c.stopCleanup:
				return
			}
		}
	}()

	return c
}

// Get returns the value if found and not expired.
// Expired entries are not removed here — cleanup goroutine handles that.
func (c *TTLCache[K, V]) Get(key K) (V, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expiresAt) {
		var zero V
		return zero, false
	}
	return e.value, true
}

func (c *TTLCache[K, V]) Set(key K, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries[key] = entry[V]{
		value:     value,
		expiresAt: time.Now().Add(c.ttl),
	}
}

func (c *TTLCache[K, V]) Delete(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.entries, key)
}

// DeleteFunc removes all entries matching the predicate.
// Useful for invalidating all cache entries for a user (e.g. on role change).
func (c *TTLCache[K, V]) DeleteFunc(predicate func(key K) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for key := range c.entries {
		if predicate(key) {
			delete(c.entries, key)
		}
	}
}

func (c *TTLCache[K, V]) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries = make(map[K]entry[V])
}

// Len returns the total entry count (including expired).
func (c *TTLCache[K, V]) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return len(c.entries)
}

// Close stops the cleanup goroutine.
func (c *TTLCache[K, V]) Close() {
	close(c.stopCleanup)
}

func (c *TTLCache[K, V]) evictExpired() {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	for key, e := range c.entries {
		if now.After(e.expiresAt) {
			delete(c.entries, key)
		}
	}
}
