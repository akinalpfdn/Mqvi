package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/geoip"
	"github.com/akinalp/mqvi/pkg/password"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/testutil"
	"github.com/akinalp/mqvi/testutil/dbtest"
	"golang.org/x/crypto/bcrypt"
)

// Optional attaches the user a valid token belongs to, and lets everything else through as no one.
func TestOptional_AttachesASignedInUserAndPassesTheRestThrough(t *testing.T) {
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

	var seen string
	handler := NewAuthMiddleware(authSvc, users).Optional(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = ""
		if user, ok := r.Context().Value(ctxkeys.User).(*models.User); ok {
			seen = user.ID
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	call := func(header string) (int, string) {
		req := httptest.NewRequest(http.MethodPost, "/api/client-errors", nil)
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		return rr.Code, seen
	}

	tests := []struct {
		name     string
		header   string
		wantUser string
	}{
		{"valid token", "Bearer " + tokens.AccessToken, "u1"},
		{"no header", "", ""},
		{"malformed header", "Token abc", ""},
		{"forged token", "Bearer not.a.jwt", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			code, user := call(tt.header)
			if code != http.StatusNoContent || user != tt.wantUser {
				t.Fatalf("status %d user %q, want 204 and %q", code, user, tt.wantUser)
			}
		})
	}

	// A signed-out session is no one, not an error.
	if _, err := fx.DB.Exec(`DELETE FROM sessions`); err != nil {
		t.Fatalf("sign out: %v", err)
	}
	if code, user := call("Bearer " + tokens.AccessToken); code != http.StatusNoContent || user != "" {
		t.Fatalf("after sign-out: status %d user %q, want 204 and no user", code, user)
	}
}
