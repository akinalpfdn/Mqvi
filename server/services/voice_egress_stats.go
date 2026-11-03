// Package services — timing of the voice egress queue.
//
// The queue resolves each event's audience from the database before delivering it. When that is
// slow, events wait behind each other and members see voice changes late. These numbers are taken
// on the server, so they are free of the network and the clients that measure end to end.
package services

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

const (
	egressStatsWindow = 10 * time.Second
	egressWarnEvery   = time.Minute
	// A window is reported when it was slow, or busy enough that its numbers are worth having.
	egressBusyTasks   = 300 // 30 tasks a second
	egressSlowWaitP95 = 250 * time.Millisecond
	egressSlowWaitMax = time.Second
	egressSlowFilter  = 250 * time.Millisecond
	egressDeepQueue   = 50
	egressSampleCap   = 20_000 // per series per window; a percentile from the first 20k is plenty
)

// egressStats aggregates the queue's timing over fixed windows. A quiet, healthy queue reports
// nothing. A slow or busy window is written to the journal; a slow one also reaches the admin log,
// at most once a minute.
type egressStats struct {
	mu           sync.Mutex
	now          func() time.Time
	start        time.Time
	waits        []time.Duration // enqueue → start
	runs         []time.Duration // start → delivered
	filters      []time.Duration // audience permission read
	tasks        int
	recipients   int
	filterErrors int
	maxDepth     int
	lastWarn     time.Time
	journal      func(line string)
	warn         func(message string, metadata map[string]string)
}

func newEgressStats(journal func(string), warn func(string, map[string]string)) *egressStats {
	return &egressStats{now: time.Now, journal: journal, warn: warn}
}

// task records one finished queue task; depth is how many were waiting behind it when it was queued.
func (s *egressStats) task(wait, run time.Duration, depth int) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if s.start.IsZero() {
		s.start = now
	}
	s.tasks++
	s.waits = appendCapped(s.waits, wait)
	s.runs = appendCapped(s.runs, run)
	if depth > s.maxDepth {
		s.maxDepth = depth
	}
	if now.Sub(s.start) >= egressStatsWindow {
		s.flushLocked(now)
	}
}

// filter records one audience permission read.
func (s *egressStats) filter(d time.Duration, failed bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.filters = appendCapped(s.filters, d)
	if failed {
		s.filterErrors++
	}
}

// delivered records how many members one event went to.
func (s *egressStats) delivered(n int) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.recipients += n
	s.mu.Unlock()
}

func (s *egressStats) flushLocked(now time.Time) {
	elapsed := now.Sub(s.start)
	waitP50, waitP95, waitMax := durationPercentile(s.waits, 50), durationPercentile(s.waits, 95), durationPercentile(s.waits, 100)
	filterP50, filterP95, filterMax := durationPercentile(s.filters, 50), durationPercentile(s.filters, 95), durationPercentile(s.filters, 100)
	runP95, runMax := durationPercentile(s.runs, 95), durationPercentile(s.runs, 100)

	slow := waitP95 > egressSlowWaitP95 || waitMax > egressSlowWaitMax || filterMax > egressSlowFilter ||
		s.filterErrors > 0 || s.maxDepth > egressDeepQueue
	busy := s.tasks >= egressBusyTasks

	if slow || busy {
		tag := "busy"
		if slow {
			tag = "SLOW"
		}
		s.journal(fmt.Sprintf("[voice] egress %s %.1fs: tasks=%d (%.0f/s) recipients=%d wait p50=%s p95=%s max=%s filter p50=%s p95=%s max=%s errors=%d run p95=%s max=%s depth max=%d",
			tag, elapsed.Seconds(), s.tasks, float64(s.tasks)/elapsed.Seconds(), s.recipients,
			fmtMs(waitP50), fmtMs(waitP95), fmtMs(waitMax), fmtMs(filterP50), fmtMs(filterP95), fmtMs(filterMax), s.filterErrors,
			fmtMs(runP95), fmtMs(runMax), s.maxDepth))
	}
	if slow && s.warn != nil && now.Sub(s.lastWarn) >= egressWarnEvery {
		s.lastWarn = now
		s.warn(fmt.Sprintf("voice egress slow: events waited up to %s (p95 %s), audience reads up to %s", fmtMs(waitMax), fmtMs(waitP95), fmtMs(filterMax)),
			map[string]string{
				"window_s":      fmt.Sprintf("%.1f", elapsed.Seconds()),
				"tasks":         fmt.Sprint(s.tasks),
				"recipients":    fmt.Sprint(s.recipients),
				"wait_p95":      fmtMs(waitP95),
				"wait_max":      fmtMs(waitMax),
				"filter_p95":    fmtMs(filterP95),
				"filter_max":    fmtMs(filterMax),
				"filter_errors": fmt.Sprint(s.filterErrors),
				"max_depth":     fmt.Sprint(s.maxDepth),
			})
	}

	s.start = now
	s.waits, s.runs, s.filters = s.waits[:0], s.runs[:0], s.filters[:0]
	s.tasks, s.recipients, s.filterErrors, s.maxDepth = 0, 0, 0, 0
}

func appendCapped(series []time.Duration, d time.Duration) []time.Duration {
	if len(series) >= egressSampleCap {
		return series
	}
	return append(series, d)
}

// durationPercentile is the nearest-rank percentile; zero for no samples.
func durationPercentile(samples []time.Duration, p int) time.Duration {
	if len(samples) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	rank := (p*len(sorted) + 99) / 100
	if rank < 1 {
		rank = 1
	}
	return sorted[rank-1]
}

func fmtMs(d time.Duration) string { return fmt.Sprintf("%.1fms", float64(d.Microseconds())/1000) }
