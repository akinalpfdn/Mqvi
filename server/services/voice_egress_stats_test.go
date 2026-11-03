package services

import (
	"strings"
	"sync"
	"testing"
	"time"
)

type statsSink struct {
	journal []string
	warns   []string
}

func statsHarness() (*egressStats, *statsSink, *time.Time) {
	sink := &statsSink{}
	now := time.Date(2026, 11, 3, 7, 0, 0, 0, time.UTC)
	s := newEgressStats(func(l string) { sink.journal = append(sink.journal, l) },
		func(m string, _ map[string]string) { sink.warns = append(sink.warns, m) })
	s.now = func() time.Time { return now }
	return s, sink, &now
}

// runWindow feeds n tasks over one window and closes it.
func runWindow(s *egressStats, now *time.Time, n int, wait time.Duration, depth int) {
	for i := 0; i < n; i++ {
		s.task(wait, time.Millisecond, depth)
	}
	*now = now.Add(egressStatsWindow)
	s.task(wait, time.Millisecond, depth)
}

// A healthy server must not write a line per window: nothing for a quiet, fast queue.
func TestEgressStats_QuietHealthyWindowWritesNothing(t *testing.T) {
	s, sink, now := statsHarness()
	runWindow(s, now, 20, 2*time.Millisecond, 1)
	if len(sink.journal) != 0 || len(sink.warns) != 0 {
		t.Fatalf("journal %v warns %v; a healthy window must be silent", sink.journal, sink.warns)
	}
}

func TestEgressStats_BusyWindowGoesToTheJournalOnly(t *testing.T) {
	s, sink, now := statsHarness()
	runWindow(s, now, egressBusyTasks, 5*time.Millisecond, 2)
	if len(sink.journal) != 1 || !strings.Contains(sink.journal[0], "egress busy") {
		t.Fatalf("journal %v, want one busy line", sink.journal)
	}
	if len(sink.warns) != 0 {
		t.Fatalf("a busy but fast queue reached the admin log: %v", sink.warns)
	}
}

func TestEgressStats_SlowWindowWarnsOncePerMinute(t *testing.T) {
	s, sink, now := statsHarness()
	runWindow(s, now, 10, 2*time.Second, 1) // events waited two seconds
	runWindow(s, now, 10, 2*time.Second, 1) // ten seconds later, still slow
	if len(sink.journal) != 2 || !strings.Contains(sink.journal[0], "egress SLOW") {
		t.Fatalf("journal %v, want both slow windows", sink.journal)
	}
	if len(sink.warns) != 1 {
		t.Fatalf("%d admin warnings within a minute, want 1", len(sink.warns))
	}
	*now = now.Add(egressWarnEvery)
	runWindow(s, now, 10, 2*time.Second, 1)
	if len(sink.warns) != 2 {
		t.Fatalf("%d admin warnings after a minute, want 2", len(sink.warns))
	}
}

// An audience that could not be read means viewers missed an event: always worth a line.
func TestEgressStats_FilterErrorMakesTheWindowSlow(t *testing.T) {
	s, sink, now := statsHarness()
	s.filter(time.Millisecond, true)
	runWindow(s, now, 5, time.Millisecond, 1)
	if len(sink.warns) != 1 || !strings.Contains(sink.journal[0], "errors=1") {
		t.Fatalf("journal %v warns %v", sink.journal, sink.warns)
	}
}

func TestEgressStats_DeepQueueMakesTheWindowSlow(t *testing.T) {
	s, sink, now := statsHarness()
	runWindow(s, now, 5, time.Millisecond, egressDeepQueue+1)
	if len(sink.warns) != 1 {
		t.Fatalf("a backlog of %d did not warn", egressDeepQueue+1)
	}
}

// The queue reports each task's wait and the backlog it joined.
func TestKeyedSerialQueue_ReportsWaitAndDepth(t *testing.T) {
	var mu sync.Mutex
	var depths []int
	var waits []time.Duration
	q := newKeyedSerialQueue(func(wait, _ time.Duration, depth int) {
		mu.Lock()
		depths = append(depths, depth)
		waits = append(waits, wait)
		mu.Unlock()
	})
	started, release := make(chan struct{}), make(chan struct{})
	q.run("srv", func() { close(started); <-release })
	<-started // the worker is busy: the next two queue behind it
	q.run("srv", func() {})
	q.run("srv", func() {})
	time.Sleep(20 * time.Millisecond)
	close(release)
	waitFor(t, "three tasks", func() bool { mu.Lock(); defer mu.Unlock(); return len(depths) == 3 })

	mu.Lock()
	defer mu.Unlock()
	if depths[0] != 0 || depths[1] != 0 || depths[2] != 1 {
		t.Fatalf("depths %v, want [0 0 1] — waiting tasks ahead of each", depths)
	}
	if waits[1] < 20*time.Millisecond {
		t.Fatalf("second task waited %s behind a blocked one, want >= 20ms", waits[1])
	}
}
