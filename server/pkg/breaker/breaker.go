// Package breaker stops calling a dependency that is already known to be down.
//
// The point is not to fail faster — it is to stop paying for the failure. A push send that is
// going to time out anyway still checks out a database connection on its way to timing out, and
// the pool has four of them. Without this, an FCM outage becomes a message-send outage.
package breaker

import (
	"sync"
	"time"
)

type Breaker struct {
	mu        sync.Mutex
	threshold int
	window    time.Duration
	openFor   time.Duration
	failures  []time.Time
	openUntil time.Time
}

func New(threshold int, window, openFor time.Duration) *Breaker {
	if threshold <= 0 {
		threshold = 5
	}
	if window <= 0 {
		window = 30 * time.Second
	}
	if openFor <= 0 {
		openFor = 30 * time.Second
	}
	return &Breaker{threshold: threshold, window: window, openFor: openFor}
}

// Allow reports whether the dependency is worth calling right now.
func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return time.Now().After(b.openUntil)
}

// Record feeds the outcome of a call back in. One success closes the breaker: a dependency that
// answered is up, and holding it open past that would drop notifications for no reason.
func (b *Breaker) Record(ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if ok {
		b.failures = nil
		return
	}

	now := time.Now()
	cutoff := now.Add(-b.window)
	kept := b.failures[:0]
	for _, ts := range b.failures {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	b.failures = append(kept, now)
	if len(b.failures) >= b.threshold {
		b.openUntil = now.Add(b.openFor)
		b.failures = nil
	}
}
