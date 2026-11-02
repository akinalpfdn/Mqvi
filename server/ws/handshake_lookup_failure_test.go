package ws

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// A lookup that failed during the handshake is not a revoked session or a missing user: it must
// not be answered or logged as one.

var errHandshakeDB = errors.New("database is locked")

type sessionCheck struct{ err error }

func (s sessionCheck) ValidateAccessToken(string) (*models.TokenClaims, error) {
	return &models.TokenClaims{UserID: "u1"}, nil
}

func (s sessionCheck) ValidateSession(context.Context, *models.TokenClaims) error {
	return s.err
}

type userLookup struct{ err error }

func (u userLookup) GetByID(context.Context, string) (*models.User, error) {
	return nil, u.err
}

func handshake(validator TokenValidator, users UserInfoProvider) int {
	h := &Handler{hub: newHub(), tokenValidator: validator, userInfoProvider: users}
	rec := httptest.NewRecorder()
	h.HandleConnection(rec, httptest.NewRequest(http.MethodGet, "/ws?token=stub", nil))
	return rec.Code
}

func TestHandleConnection_ShouldAnswer500WhenTheSessionCheckFails(t *testing.T) {
	if got := handshake(sessionCheck{err: fmt.Errorf("failed to check session: %w", errHandshakeDB)}, userLookup{}); got != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", got)
	}
}

func TestHandleConnection_ShouldStillAnswer401ForARevokedSession(t *testing.T) {
	if got := handshake(sessionCheck{err: fmt.Errorf("%w: session revoked", pkg.ErrUnauthorized)}, userLookup{}); got != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", got)
	}
}

func TestHandleConnection_ShouldAnswer500WhenTheUserLookupFails(t *testing.T) {
	if got := handshake(sessionCheck{}, userLookup{err: errHandshakeDB}); got != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", got)
	}
}

func TestHandleConnection_ShouldStillAnswer401ForAMissingUser(t *testing.T) {
	if got := handshake(sessionCheck{}, userLookup{err: pkg.ErrNotFound}); got != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", got)
	}
}
