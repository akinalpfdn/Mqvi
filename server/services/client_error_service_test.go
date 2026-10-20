package services

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
)

type clientErrorLog struct {
	category models.LogCategory
	userID   *string
	message  string
	metadata map[string]string
}

type fakeClientErrorLogger struct{ logs []clientErrorLog }

func (f *fakeClientErrorLogger) Log(_ models.LogLevel, category models.LogCategory, userID, _ *string, message string, metadata map[string]string) {
	f.logs = append(f.logs, clientErrorLog{category, userID, message, metadata})
}

func TestClientError_ScrubsWhatCouldIdentifySomeone(t *testing.T) {
	tests := []struct {
		name  string
		in    ClientErrorReport
		check func(t *testing.T, got clientErrorLog)
	}{
		{
			name: "jwt in the message",
			in:   ClientErrorReport{Message: "bad token eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl here"},
			check: func(t *testing.T, got clientErrorLog) {
				if strings.Contains(got.message, "eyJ") || !strings.Contains(got.message, "[token]") {
					t.Fatalf("message = %q", got.message)
				}
			},
		},
		{
			name: "bearer header in the stack",
			in:   ClientErrorReport{Message: "x", Stack: "Authorization: Bearer abc.def-ghi"},
			check: func(t *testing.T, got clientErrorLog) {
				if got.metadata["stack"] != "Authorization: Bearer [token]" {
					t.Fatalf("stack = %q", got.metadata["stack"])
				}
			},
		},
		{
			name: "email address",
			in:   ClientErrorReport{Message: "no user ali.veli@example.com"},
			check: func(t *testing.T, got clientErrorLog) {
				if got.message != "client error: no user [email]" {
					t.Fatalf("message = %q", got.message)
				}
			},
		},
		{
			name: "signed url query",
			in:   ClientErrorReport{Message: "failed https://mqvi.net/api/files/a.png?token=secret&exp=1"},
			check: func(t *testing.T, got clientErrorLog) {
				if got.message != "client error: failed https://mqvi.net/api/files/a.png?[query]" {
					t.Fatalf("message = %q", got.message)
				}
			},
		},
		{
			name: "ids and query in the route",
			in:   ClientErrorReport{Message: "x", Route: "/channels/0193f1e2-7a4b-7c3d/12345678?tab=1#top"},
			check: func(t *testing.T, got clientErrorLog) {
				if got.metadata["route"] != "/channels/:id/:id" {
					t.Fatalf("route = %q", got.metadata["route"])
				}
			},
		},
		{
			name: "unknown platform, kind and version",
			in:   ClientErrorReport{Message: "x", Platform: "<script>", Kind: "drop table", AppVersion: "1.0 ; rm"},
			check: func(t *testing.T, got clientErrorLog) {
				if got.metadata["platform"] != "unknown" || got.metadata["kind"] != "error" || got.metadata["app_version"] != "" {
					t.Fatalf("metadata = %v", got.metadata)
				}
			},
		},
		{
			name: "oversized message",
			in:   ClientErrorReport{Message: strings.Repeat("ğ", maxClientErrorMessage+50)},
			check: func(t *testing.T, got clientErrorLog) {
				body := strings.TrimPrefix(got.message, "client error: ")
				if n := len([]rune(body)); n != maxClientErrorMessage+1 { // the kept runes plus "…"
					t.Fatalf("message runes = %d", n)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := &fakeClientErrorLogger{}
			NewClientErrorService(logger).Record([]ClientErrorReport{tt.in})
			if len(logger.logs) != 1 {
				t.Fatalf("logs = %d, want 1", len(logger.logs))
			}
			got := logger.logs[0]
			if got.category != models.LogCategoryClient || got.userID != nil {
				t.Fatalf("category %q user %v: want client and no user", got.category, got.userID)
			}
			tt.check(t, got)
		})
	}
}

func TestClientError_SkipsEmptyAndCapsTheBatch(t *testing.T) {
	logger := &fakeClientErrorLogger{}
	reports := []ClientErrorReport{{Message: "  "}}
	for i := 0; i < MaxClientErrorsPerBatch+3; i++ {
		reports = append(reports, ClientErrorReport{Message: fmt.Sprintf("boom %d", i)})
	}
	NewClientErrorService(logger).Record(reports)
	// The batch is cut first, then the blank one is skipped.
	if len(logger.logs) != MaxClientErrorsPerBatch-1 {
		t.Fatalf("logs = %d, want %d", len(logger.logs), MaxClientErrorsPerBatch-1)
	}
}

func TestClientError_StoresTheSameErrorOncePerWindow(t *testing.T) {
	logger := &fakeClientErrorLogger{}
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	svc := newClientErrorService(logger, func() time.Time { return now })
	report := ClientErrorReport{Message: "boom", Stack: "Error: boom\n    at a (app.js:1:1)", Platform: "android", AppVersion: "1.1.0"}

	svc.Record([]ClientErrorReport{report, report})
	now = now.Add(30 * time.Minute)
	svc.Record([]ClientErrorReport{report})
	if len(logger.logs) != 1 {
		t.Fatalf("within the window: %d logs, want 1", len(logger.logs))
	}

	other := report
	other.Platform = "ios"
	svc.Record([]ClientErrorReport{other})
	if len(logger.logs) != 2 {
		t.Fatalf("same error on another platform: %d logs, want 2", len(logger.logs))
	}

	now = now.Add(clientErrorDedupeWindow)
	svc.Record([]ClientErrorReport{report})
	if len(logger.logs) != 3 {
		t.Fatalf("after the window: %d logs, want 3", len(logger.logs))
	}
}

func TestClientError_CapsTheTotalPerMinute(t *testing.T) {
	logger := &fakeClientErrorLogger{}
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	svc := newClientErrorService(logger, func() time.Time { return now })
	flood := func(prefix string, n int) {
		for i := 0; i < n; i++ {
			svc.Record([]ClientErrorReport{{Message: fmt.Sprintf("%s %d", prefix, i)}})
		}
	}

	flood("a", ClientErrorsPerMinute+10)
	if len(logger.logs) != ClientErrorsPerMinute {
		t.Fatalf("first minute: %d logs, want %d", len(logger.logs), ClientErrorsPerMinute)
	}

	now = now.Add(time.Minute)
	flood("b", 3)
	if len(logger.logs) != ClientErrorsPerMinute+3 {
		t.Fatalf("next minute: %d logs, want %d", len(logger.logs), ClientErrorsPerMinute+3)
	}
}

func TestClientError_ConcurrentReportsStayWithinTheCap(t *testing.T) {
	logger := &lockedClientErrorLogger{}
	svc := NewClientErrorService(logger)
	done := make(chan struct{})
	for g := 0; g < 8; g++ {
		go func(g int) {
			for i := 0; i < 20; i++ {
				svc.Record([]ClientErrorReport{{Message: fmt.Sprintf("g%d-%d", g, i)}})
			}
			done <- struct{}{}
		}(g)
	}
	for g := 0; g < 8; g++ {
		<-done
	}
	if n := logger.count(); n > ClientErrorsPerMinute {
		t.Fatalf("%d logs, want at most %d", n, ClientErrorsPerMinute)
	}
}

type lockedClientErrorLogger struct {
	mu sync.Mutex
	n  int
}

func (l *lockedClientErrorLogger) Log(models.LogLevel, models.LogCategory, *string, *string, string, map[string]string) {
	l.mu.Lock()
	l.n++
	l.mu.Unlock()
}

func (l *lockedClientErrorLogger) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.n
}
