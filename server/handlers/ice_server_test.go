package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/ratelimit"
)

type fakeICEProvider struct{}

func (fakeICEProvider) ICEServers(string) []models.ICEServer {
	return []models.ICEServer{{URLs: []string{"stun:stun.test:3478"}}}
}

type fakeCallChecker struct{ active bool }

func (f fakeCallChecker) HasActiveCall(string) bool { return f.active }

func iceReq(u *models.User) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/calls/ice-servers", nil)
	if u != nil {
		r = r.WithContext(context.WithValue(r.Context(), ctxkeys.User, u))
	}
	return r
}

func TestGetICEServers_Unauthenticated(t *testing.T) {
	h := NewICEServerHandler(fakeICEProvider{}, fakeCallChecker{}, nil)
	w := httptest.NewRecorder()
	h.GetICEServers(w, iceReq(nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", w.Code)
	}
}

func TestGetICEServers_NoActiveCall(t *testing.T) {
	h := NewICEServerHandler(fakeICEProvider{}, fakeCallChecker{active: false}, nil)
	w := httptest.NewRecorder()
	h.GetICEServers(w, iceReq(&models.User{ID: "u1"}))
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403 when no active call", w.Code)
	}
}

func TestGetICEServers_Success(t *testing.T) {
	cc := fakeCallChecker{active: true}
	h := NewICEServerHandler(fakeICEProvider{}, cc, nil)
	w := httptest.NewRecorder()
	h.GetICEServers(w, iceReq(&models.User{ID: "u1"}))

	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}

	var resp struct {
		Success bool                      `json:"success"`
		Data    models.ICEServersResponse `json:"data"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !resp.Success || len(resp.Data.ICEServers) != 1 {
		t.Errorf("unexpected body: %+v", resp)
	}
}

func TestGetICEServers_RateLimited(t *testing.T) {
	cc := fakeCallChecker{active: true}
	limiter := ratelimit.NewMessageRateLimiter(1, time.Minute, time.Minute)
	h := NewICEServerHandler(fakeICEProvider{}, cc, limiter)
	u := &models.User{ID: "u1"}

	w1 := httptest.NewRecorder()
	h.GetICEServers(w1, iceReq(u))
	if w1.Code != http.StatusOK {
		t.Fatalf("first request got %d, want 200", w1.Code)
	}

	w2 := httptest.NewRecorder()
	h.GetICEServers(w2, iceReq(u))
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("second request got %d, want 429", w2.Code)
	}
}
