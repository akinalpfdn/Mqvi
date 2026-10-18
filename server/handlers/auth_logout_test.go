package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
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

// A sign-out made while offline is sent later, when the access token has long lapsed. The refresh
// token alone has to be enough, or the server-side session outlives the sign-out.
func TestLogout_ShouldEndTheSessionWithoutAnAccessToken(t *testing.T) {
	fx := dbtest.New(t)
	hash, err := bcrypt.GenerateFromPassword([]byte("correct horse battery staple"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if _, err := fx.DB.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', ?)`, string(hash)); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	authSvc := services.NewAuthService(
		repository.NewSQLiteUserRepo(fx.DB), repository.NewSQLiteSessionRepo(fx.DB),
		&testutil.MockResetRepo{}, &testutil.MockEventPublisher{}, &testutil.MockEmailSender{},
		password.NoopChecker{}, geoip.Noop{}, "test-secret", []byte("0123456789abcdef0123456789abcdef"), 15, 90, 24,
	)
	tokens, err := authSvc.Login(context.Background(), &models.LoginRequest{Username: "alice", Password: "correct horse battery staple"}, models.ClientInfo{})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	h := NewAuthHandler(authSvc, nil, nil, nil, nil, nil, 0)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout",
		strings.NewReader(`{"refresh_token":"`+tokens.RefreshToken+`"}`))
	rr := httptest.NewRecorder()
	h.Logout(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var left int
	if err := fx.DB.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatal("session survived logout")
	}
}
