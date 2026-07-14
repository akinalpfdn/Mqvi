package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/authcookie"
	"github.com/akinalp/mqvi/pkg/fileacl"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/testutil"
)

type fileTokenAuthStub struct {
	claims *models.TokenClaims
	err    error
}

func (s fileTokenAuthStub) Register(context.Context, *models.CreateUserRequest) (*services.AuthTokens, error) {
	return nil, nil
}
func (s fileTokenAuthStub) Login(context.Context, *models.LoginRequest) (*services.AuthTokens, error) {
	return nil, nil
}
func (s fileTokenAuthStub) RefreshToken(context.Context, string) (*services.AuthTokens, error) {
	return nil, nil
}
func (s fileTokenAuthStub) Logout(context.Context, string) error {
	return nil
}
func (s fileTokenAuthStub) ValidateAccessToken(string) (*models.TokenClaims, error) {
	return nil, nil
}
func (s fileTokenAuthStub) ValidateFileToken(string) (*models.TokenClaims, error) {
	return s.claims, s.err
}
func (s fileTokenAuthStub) ChangePassword(context.Context, string, string, string) (*services.AuthTokens, error) {
	return nil, nil
}
func (s fileTokenAuthStub) ChangeEmail(context.Context, string, string, string) error {
	return nil
}
func (s fileTokenAuthStub) ForgotPassword(context.Context, string) (int, error) {
	return 0, nil
}
func (s fileTokenAuthStub) ResetPassword(context.Context, string, string) error {
	return nil
}
func (s fileTokenAuthStub) SoftDeleteSelf(context.Context, string, string) error {
	return nil
}
func (s fileTokenAuthStub) RestoreAccount(context.Context, string, string) (*services.AuthTokens, error) {
	return nil, nil
}
func (s fileTokenAuthStub) SetAppLogger(services.AuthAppLogger) {}

func TestReadJWTTokens_CookieOnly(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/files/avatars/u/x.png", nil)
	r.AddCookie(&http.Cookie{Name: authcookie.Name, Value: "cookie-jwt"})
	got := readJWTTokens(r)
	if len(got) != 1 || got[0] != "cookie-jwt" {
		t.Fatalf("got %v want [cookie-jwt]", got)
	}
}

func TestReadJWTTokens_BearerOnly(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/files/avatars/u/x.png", nil)
	r.Header.Set("Authorization", "Bearer header-jwt")
	got := readJWTTokens(r)
	if len(got) != 1 || got[0] != "header-jwt" {
		t.Fatalf("got %v want [header-jwt]", got)
	}
}

func TestReadJWTTokens_BothReturnsBothCookieFirst(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/files/avatars/u/x.png", nil)
	r.AddCookie(&http.Cookie{Name: authcookie.Name, Value: "cookie-jwt"})
	r.Header.Set("Authorization", "Bearer header-jwt")
	got := readJWTTokens(r)
	if len(got) != 2 || got[0] != "cookie-jwt" || got[1] != "header-jwt" {
		t.Fatalf("got %v want [cookie-jwt header-jwt]", got)
	}
}

func TestReadJWTTokens_None(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/files/avatars/u/x.png", nil)
	if got := readJWTTokens(r); len(got) != 0 {
		t.Fatalf("got %v want empty", got)
	}
}

func TestReadJWTTokens_MalformedAuthorizationIgnored(t *testing.T) {
	cases := []string{"Basic abc:def", "bearer lowercase-prefix", "BearerNoSpace"}
	for _, h := range cases {
		r := httptest.NewRequest(http.MethodGet, "/api/files/avatars/u/x.png", nil)
		r.Header.Set("Authorization", h)
		if got := readJWTTokens(r); len(got) != 0 {
			t.Errorf("Authorization=%q: got %v want empty", h, got)
		}
	}
}

func TestReadJWTTokens_OtherCookiesIgnored(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/files/avatars/u/x.png", nil)
	r.AddCookie(&http.Cookie{Name: "session", Value: "wrong-cookie"})
	r.AddCookie(&http.Cookie{Name: "csrf", Value: "noise"})
	if got := readJWTTokens(r); len(got) != 0 {
		t.Fatalf("only mqvi_file_session counts; got %v", got)
	}
}

func TestRoutesToAPI(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		// The whole point: this path used to fall through to the SPA, so Android fetched the
		// asset-links statement and got index.html back. It must reach the mux.
		{"asset links statement", "/.well-known/assetlinks.json", true},
		{"api", "/api/messages", true},
		{"static", "/static/landing/hero.mp4", true},

		// Certbot's HTTP-01 challenge is not ours to answer — the match must be exact.
		{"acme challenge", "/.well-known/acme-challenge/xyz", false},
		{"other well-known", "/.well-known/security.txt", false},

		// SPA routes, including the two the app claims: a browser must still get the web page.
		{"landing", "/", false},
		{"invite", "/invite/abc", false},
		{"channels", "/channels/1/2", false},
		{"login", "/login", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := routesToAPI(tt.path); got != tt.want {
				t.Errorf("routesToAPI(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestCheckFileTokenRejectsTokenVersionMismatch(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/files/avatars/u1/a.png", nil)
	authSvc := fileTokenAuthStub{claims: &models.TokenClaims{UserID: "u1", TokenVersion: 1}}
	userRepo := &testutil.MockUserRepo{
		GetActiveByIDFn: func(context.Context, string) (*models.User, error) {
			return &models.User{ID: "u1", TokenVersion: 2}, nil
		},
	}
	acl := fileacl.NewChecker(nil, nil, nil, nil, nil, nil, nil)

	if _, ok := checkFileToken(r, "file-token", "/api/files/avatars/u1/a.png", authSvc, userRepo, acl); ok {
		t.Fatal("expected token_version mismatch to reject file token")
	}
}
