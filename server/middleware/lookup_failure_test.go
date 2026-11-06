package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/geoip"
	"github.com/akinalp/mqvi/pkg/password"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/testutil/dbtest"
	"golang.org/x/crypto/bcrypt"
)

// A lookup that failed has said nothing about the caller. Answered 401 or 404 it signs everyone
// out, or hides their servers, at once over a database hiccup, and the cause reaches no log.

var errDatabaseLocked = errors.New("database is locked")

type failingActiveUser struct {
	repository.UserRepository
	err error
}

func (f failingActiveUser) GetActiveByID(context.Context, string) (*models.User, error) {
	return nil, f.err
}

type failingActiveServer struct {
	repository.ServerRepository // nil: any other call panics, which the test would show
	err                         error
}

func (f failingActiveServer) GetActiveByID(context.Context, string) (*models.Server, error) {
	return nil, f.err
}

// signedIn seeds one user, signs them in and returns their access token with the services behind it.
func signedIn(t *testing.T) (*dbtest.Fixture, repository.UserRepository, services.AuthService, string) {
	t.Helper()
	fx := dbtest.New(t)
	hash, err := bcrypt.GenerateFromPassword([]byte("correct horse battery staple"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if _, err := fx.DB.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', ?)`, string(hash)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	users := repository.NewSQLiteUserRepo(fx.DB)
	authSvc := services.NewAuthService(
		users, repository.NewSQLiteSessionRepo(fx.DB),
		&testutil.MockResetRepo{}, &testutil.MockEventPublisher{}, &testutil.MockEmailSender{},
		password.NoopChecker{}, geoip.Noop{}, "test-secret", []byte("0123456789abcdef0123456789abcdef"), 15, 90, 24,
	)
	tokens, err := authSvc.Login(context.Background(),
		&models.LoginRequest{Username: "alice", Password: "correct horse battery staple"}, models.ClientInfo{})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	return fx, users, authSvc, tokens.AccessToken
}

func callRequire(m *AuthMiddleware, token string) int {
	protected := m.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/users/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	protected.ServeHTTP(rr, req)
	return rr.Code
}

func TestRequire_ShouldAnswer500NotUnauthorizedWhenTheUserLookupFails(t *testing.T) {
	_, users, authSvc, token := signedIn(t)

	got := callRequire(NewAuthMiddleware(authSvc, failingActiveUser{UserRepository: users, err: errDatabaseLocked}), token)

	if got != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", got)
	}
}

func TestRequire_ShouldStillRejectADeletedAccountWith401(t *testing.T) {
	fx, users, authSvc, token := signedIn(t)
	if _, err := fx.DB.Exec(`UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'u1'`); err != nil {
		t.Fatalf("delete: %v", err)
	}

	if got := callRequire(NewAuthMiddleware(authSvc, users), token); got != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", got)
	}
}

func callMembership(repo repository.ServerRepository) int {
	protected := NewServerMembershipMiddleware(repo).Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/servers/s1/channels", nil)
	req.SetPathValue("serverId", "s1")
	req = req.WithContext(context.WithValue(req.Context(), ctxkeys.User, &models.User{ID: "u1"}))
	rr := httptest.NewRecorder()
	protected.ServeHTTP(rr, req)
	return rr.Code
}

func TestServerMembership_ShouldAnswer500NotNotFoundWhenTheServerLookupFails(t *testing.T) {
	if got := callMembership(failingActiveServer{err: errDatabaseLocked}); got != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", got)
	}
}

func TestServerMembership_ShouldStillAnswer404ForADeletedServer(t *testing.T) {
	if got := callMembership(failingActiveServer{err: pkg.ErrNotFound}); got != http.StatusNotFound {
		t.Fatalf("status %d, want 404", got)
	}
}
