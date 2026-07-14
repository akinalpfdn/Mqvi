package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The readiness endpoint does a database round trip per request against a four-connection pool
// and reports goroutine counts, pool statistics and socket counts. On the public mux that is the
// same DoS the read endpoints were rate-limited against, plus an information leak. It belongs on
// its own loopback listener — and a RemoteAddr check would NOT have been enough, because behind
// the reverse proxy every request already arrives from 127.0.0.1.
func TestPublicMux_DoesNotServeReadiness(t *testing.T) {
	mux := http.NewServeMux()
	registerLiveness(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health/ready", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("the public mux answered /api/health/ready with %d — it must not be reachable from the internet", rec.Code)
	}
}

// Liveness stays public and stays cheap: it is what the supervisor and the uptime monitor poll,
// and it must not touch the database.
func TestPublicMux_ServesLiveness(t *testing.T) {
	mux := http.NewServeMux()
	registerLiveness(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("liveness returned %d, want 200", rec.Code)
	}
}
