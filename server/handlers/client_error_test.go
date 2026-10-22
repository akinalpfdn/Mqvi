package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

type fakeClientErrorRecorder struct {
	got    []services.ClientErrorReport
	userID *string
}

func (f *fakeClientErrorRecorder) Record(r []services.ClientErrorReport, userID *string) {
	f.got = append(f.got, r...)
	f.userID = userID
}

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
		res := postClientErrors(NewClientErrorHandler(rec, nil, nil, nil), `{"errors":[{"message":"boom","platform":"android"}]}`)
		if res.Code != http.StatusNoContent || len(rec.got) != 1 || rec.got[0].Message != "boom" {
			t.Fatalf("status %d, got %+v", res.Code, rec.got)
		}
	})

	t.Run("rejects an empty or malformed body", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec, nil, nil, nil)
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
		if res := postClientErrors(NewClientErrorHandler(rec, nil, nil, nil), big); res.Code != http.StatusBadRequest || len(rec.got) != 0 {
			t.Fatalf("status %d, recorded %d", res.Code, len(rec.got))
		}
	})

	t.Run("a render crash keeps its own budget after ordinary reports used theirs", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec,
			ratelimit.NewMessageRateLimiter(1, time.Minute, time.Minute),
			ratelimit.NewMessageRateLimiter(1, time.Minute, time.Minute), nil)
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
		h := NewClientErrorHandler(rec, nil, ratelimit.NewMessageRateLimiter(1, time.Minute, time.Minute), nil)
		postClientErrors(h, `{"errors":[{"kind":"render","message":"a"},{"kind":"error","message":"b"}]}`)
		if len(rec.got) != 2 || rec.got[0].Kind != "error" {
			t.Fatalf("got %+v", rec.got)
		}
	})

	t.Run("passes on the signed-in user, and no one otherwise", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec, nil, nil, nil)
		req := httptest.NewRequest(http.MethodPost, "/api/client-errors", strings.NewReader(`{"errors":[{"message":"boom"}]}`))
		req = req.WithContext(context.WithValue(req.Context(), ctxkeys.User, &models.User{ID: "u1"}))
		h.Report(httptest.NewRecorder(), req)
		if rec.userID == nil || *rec.userID != "u1" {
			t.Fatalf("userID = %v, want u1", rec.userID)
		}
		postClientErrors(h, `{"errors":[{"message":"boom"}]}`)
		if rec.userID != nil {
			t.Fatalf("signed out: userID = %v, want nil", *rec.userID)
		}
	})

	t.Run("caps requests per IP per day", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec, nil, nil, ratelimit.NewMessageRateLimiter(2, 24*time.Hour, 24*time.Hour))
		postClientErrors(h, `{"errors":[{"message":"a"}]}`)
		postClientErrors(h, `{"errors":[{"kind":"render","message":"b"}]}`)
		if res := postClientErrors(h, `{"errors":[{"kind":"render","message":"c"}]}`); res.Code != http.StatusTooManyRequests {
			t.Fatalf("third request of the day: status %d, want 429", res.Code)
		}
	})

	t.Run("rate limits per IP", func(t *testing.T) {
		rec := &fakeClientErrorRecorder{}
		h := NewClientErrorHandler(rec, ratelimit.NewMessageRateLimiter(2, time.Minute, time.Minute), nil, nil)
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
