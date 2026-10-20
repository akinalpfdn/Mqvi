package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

type fakeClientErrorRecorder struct{ got []services.ClientErrorReport }

func (f *fakeClientErrorRecorder) Record(r []services.ClientErrorReport) { f.got = append(f.got, r...) }

func postClientErrors(h *ClientErrorHandler, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/client-errors", strings.NewReader(body))
	req.RemoteAddr = "203.0.113.7:5000"
	rec := httptest.NewRecorder()
	h.Report(rec, req)
	return rec
}

func TestClientErrorHandler(t *testing.T) {
	t.Run("stores a batch and answers with no content", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		res := postClientErrors(NewClientErrorHandler(rec, nil, nil), `{"errors":[{"message":"boom","platform":"android"}]}`)
		if res.Code != http.StatusNoContent || len(rec.got) != 1 || rec.got[0].Message != "boom" {
			t.Fatalf("status %d, got %+v", res.Code, rec.got)
		}
	})

	t.Run("rejects an empty or malformed body", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec, nil, nil)
		for _, body := range []string{`{"errors":[]}`, `not json`, ``} {
			if res := postClientErrors(h, body); res.Code != http.StatusBadRequest {
				t.Fatalf("body %q: status %d, want 400", body, res.Code)
			}
		}
		if len(rec.got) != 0 {
			t.Fatalf("recorded %d reports from bad bodies", len(rec.got))
		}
	})

	t.Run("rejects a body over the size cap", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		big := `{"errors":[{"message":"` + strings.Repeat("a", maxClientErrorBody) + `"}]}`
		if res := postClientErrors(NewClientErrorHandler(rec, nil, nil), big); res.Code != http.StatusBadRequest || len(rec.got) != 0 {
			t.Fatalf("status %d, recorded %d", res.Code, len(rec.got))
		}
	})

	t.Run("a render crash keeps its own budget after ordinary reports used theirs", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec,
			ratelimit.NewMessageRateLimiter(1, time.Minute, time.Minute),
			ratelimit.NewMessageRateLimiter(1, time.Minute, time.Minute))
		postClientErrors(h, `{"errors":[{"kind":"error","message":"ws handler"}]}`)
		if res := postClientErrors(h, `{"errors":[{"kind":"error","message":"again"}]}`); res.Code != http.StatusTooManyRequests {
			t.Fatalf("second ordinary batch: status %d, want 429", res.Code)
		}
		if res := postClientErrors(h, `{"errors":[{"kind":"render","message":"crash"}]}`); res.Code != http.StatusNoContent {
			t.Fatalf("render crash: status %d, want 204", res.Code)
		}
	})

	t.Run("a render crash inside a batch counts as an ordinary report", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec, nil, ratelimit.NewMessageRateLimiter(1, time.Minute, time.Minute))
		postClientErrors(h, `{"errors":[{"kind":"render","message":"a"},{"kind":"error","message":"b"}]}`)
		if len(rec.got) != 2 || rec.got[0].Kind != "error" {
			t.Fatalf("got %+v", rec.got)
		}
	})

	t.Run("rate limits per IP", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec, ratelimit.NewMessageRateLimiter(2, time.Minute, time.Minute), nil)
		body := `{"errors":[{"message":"boom"}]}`
		postClientErrors(h, body)
		postClientErrors(h, body)
		if res := postClientErrors(h, body); res.Code != http.StatusTooManyRequests {
			t.Fatalf("third request: status %d, want 429", res.Code)
		}
		if len(rec.got) != 2 {
			t.Fatalf("recorded %d, want 2", len(rec.got))
		}
	})
}
