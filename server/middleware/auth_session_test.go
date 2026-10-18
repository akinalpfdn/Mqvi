package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/geoip"
	"github.com/akinalp/mqvi/pkg/password"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/testutil/dbtest"
	"golang.org/x/crypto/bcrypt"
)

// Signing a device out must stop its API access now, not when its access token runs out.
func TestRequire_ShouldRejectAnAccessTokenWhoseSessionWasSignedOut(t *testing.T) {
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
	protected := NewAuthMiddleware(authSvc, users).Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	call := func() int {
		req := httptest.NewRequest(http.MethodGet, "/api/users/me", nil)
		req.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
		rr := httptest.NewRecorder()
		protected.ServeHTTP(rr, req)
		return rr.Code
	}
	if got := call(); got != http.StatusNoContent {
		t.Fatalf("before sign-out: %d", got)
	}

	if _, err := fx.DB.Exec(`DELETE FROM sessions`); err != nil {
		t.Fatalf("sign out: %v", err)
	}

	if got := call(); got != http.StatusUnauthorized {
		t.Fatalf("after sign-out: %d, want 401", got)
	}
}
