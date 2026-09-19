package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type recordingEnder struct{ callID, key string }

func (r *recordingEnder) EndCallWithKey(callID, key string) error {
	r.callID, r.key = callID, key
	return nil
}

func hangup(h *P2PHangupHandler, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/calls/{id}/hangup", h.Hangup)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/calls/c1/hangup", strings.NewReader(body)))
	return rec
}

func TestP2PHangup(t *testing.T) {
	ender := &recordingEnder{}
	h := NewP2PHangupHandler(ender, nil)

	if rec := hangup(h, `{"key":"k"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if ender.callID != "c1" || ender.key != "k" {
		t.Errorf("ended %q with %q", ender.callID, ender.key)
	}
	for _, bad := range []string{``, `{}`, `{"key":""}`, `not json`} {
		if rec := hangup(h, bad); rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: status %d, want 400", bad, rec.Code)
		}
	}
}
