package services

import (
	"context"
	"testing"
	"time"
)

type recordingPruner struct{ cutoff time.Time }

func (p *recordingPruner) DeleteExpired(context.Context, time.Time) (int64, error) { return 0, nil }
func (p *recordingPruner) ClearPending(_ context.Context, cutoff time.Time) (int64, error) {
	p.cutoff = cutoff
	return 0, nil
}

// The encrypted copy exists for the grace window only; the minute tick must clear exactly what is
// past it, not what a parallel refresh may still need.
func TestClearPendingTokens_ShouldCutOffAtTheEndOfTheGraceWindow(t *testing.T) {
	pruner := &recordingPruner{}
	s := &cleanupService{sessions: pruner}

	before := time.Now().UTC()
	s.clearPendingTokens(context.Background())

	want := before.Add(-refreshGraceWindow)
	if d := pruner.cutoff.Sub(want); d < 0 || d > time.Second {
		t.Fatalf("cutoff %v, want about %v", pruner.cutoff, want)
	}
}
