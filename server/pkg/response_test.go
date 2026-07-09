package pkg

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// B2 regression: an unmapped error hits the 500 branch and must not echo its wrapped
// internal/SQL chain to the client.
func TestError_InternalErrorIsGenericized(t *testing.T) {
	rec := httptest.NewRecorder()
	leaky := fmt.Errorf("failed to increment invite uses: %w",
		fmt.Errorf("sql: no rows in result set at users.id = secret-detail"))

	Error(rec, leaky)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status got %d want 500", rec.Code)
	}

	var resp APIResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if resp.Success {
		t.Fatal("success should be false")
	}
	if resp.Error != ErrInternal.Error() {
		t.Fatalf("error message got %q want %q", resp.Error, ErrInternal.Error())
	}
	if strings.Contains(rec.Body.String(), "sql:") || strings.Contains(rec.Body.String(), "secret-detail") {
		t.Fatalf("internal detail leaked to client: %s", rec.Body.String())
	}
}

// Mapped 4xx domain errors carry client-safe messages and must pass through unchanged.
func TestError_MappedDomainMessagesUnchanged(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantMsg    string
	}{
		{"bad request", fmt.Errorf("%w: invite code has reached max uses", ErrBadRequest), http.StatusBadRequest, "bad request: invite code has reached max uses"},
		{"not found", fmt.Errorf("%w: server is no longer available", ErrNotFound), http.StatusNotFound, "not found: server is no longer available"},
		{"forbidden", ErrForbidden, http.StatusForbidden, "forbidden"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			Error(rec, tc.err)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status got %d want %d", rec.Code, tc.wantStatus)
			}
			var resp APIResponse
			if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if resp.Error != tc.wantMsg {
				t.Fatalf("error message got %q want %q", resp.Error, tc.wantMsg)
			}
		})
	}
}
