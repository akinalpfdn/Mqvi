package handlers

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"

	"github.com/akinalp/mqvi/repository"
)

// Every upload compensation path used to be `_ = Release(...)`. A Release that fails silently
// charges the user bytes they no longer hold, forever, with nothing in the logs saying why — and
// the failure is invisible in production precisely because it is rare. These pin that the failure
// now surfaces, and that the guard around a zero release lives in one place.

type stubStorage struct {
	released   []int64
	releaseErr error
}

func (s *stubStorage) Reserve(context.Context, string, int64) error { return nil }

func (s *stubStorage) Release(_ context.Context, _ string, b int64) error {
	s.released = append(s.released, b)
	return s.releaseErr
}

func (s *stubStorage) GetUsage(context.Context, string) (*repository.UserStorage, error) {
	return nil, nil
}

func (s *stubStorage) SetQuota(context.Context, string, int64) error { return nil }

// captureLog redirects the standard logger for one call and returns what it wrote.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	flags, out := log.Flags(), log.Writer()
	log.SetFlags(0)
	log.SetOutput(&buf)
	defer func() {
		log.SetFlags(flags)
		log.SetOutput(out)
	}()
	fn()
	return buf.String()
}

func TestReleaseQuota_ReportsAFailedRelease(t *testing.T) {
	storage := &stubStorage{releaseErr: context.DeadlineExceeded}

	output := captureLog(t, func() {
		releaseQuota(context.Background(), storage, "message", "user-1", 4096)
	})

	// The byte count and the user are what make a drift traceable after the fact.
	for _, want := range []string{"message", "4096", "user-1"} {
		if !strings.Contains(output, want) {
			t.Errorf("log %q is missing %q", strings.TrimSpace(output), want)
		}
	}
}

func TestReleaseQuota_SaysNothingWhenTheReleaseSucceeds(t *testing.T) {
	storage := &stubStorage{}

	output := captureLog(t, func() {
		releaseQuota(context.Background(), storage, "dm", "user-1", 4096)
	})

	if output != "" {
		t.Errorf("logged %q on a successful release, want silence", strings.TrimSpace(output))
	}
	if len(storage.released) != 1 || storage.released[0] != 4096 {
		t.Errorf("released %v, want [4096]", storage.released)
	}
}

// Callers subtract uploaded bytes from the reservation, so a fully consumed reservation asks to
// release zero and an over-consumed one asks for a negative. Neither should reach the service.
func TestReleaseQuota_SkipsNonPositiveAmounts(t *testing.T) {
	for _, bytesToRelease := range []int64{0, -512} {
		storage := &stubStorage{releaseErr: context.DeadlineExceeded}

		output := captureLog(t, func() {
			releaseQuota(context.Background(), storage, "report", "user-1", bytesToRelease)
		})

		if len(storage.released) != 0 {
			t.Errorf("release(%d) reached the service: %v", bytesToRelease, storage.released)
		}
		if output != "" {
			t.Errorf("release(%d) logged %q, want silence", bytesToRelease, strings.TrimSpace(output))
		}
	}
}
