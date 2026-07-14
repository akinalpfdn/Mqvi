package services

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/password"
	"github.com/akinalp/mqvi/testutil"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const testJWTSecret = "test-secret-key-for-auth-service"

// preHashPassword generates a bcrypt hash at cost 4 (fast for tests).
// Tests that need to verify password comparison use this instead of cost 12.
func preHashPassword(t *testing.T, password string) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("failed to pre-hash password: %v", err)
	}
	return string(hash)
}

// A passphrase, not a composed password: the policy rejects short ones and, in production,
// anything in the breach corpus. Tests use NoopChecker so they never touch the network.
const testRegisterPassword = "correct horse battery staple"

func newTestAuthService(userRepo *testutil.MockUserRepo, sessionRepo *testutil.MockSessionRepo) AuthService {
	return NewAuthService(userRepo, sessionRepo, &testutil.MockResetRepo{}, &testutil.MockEventPublisher{}, &testutil.MockEmailSender{}, password.NoopChecker{}, testJWTSecret, 15, 7)
}

func TestRegister(t *testing.T) {
	tests := []struct {
		name      string
		req       *models.CreateUserRequest
		setupRepo func(*testutil.MockUserRepo, *testutil.MockSessionRepo)
		wantErr   bool
		errIs     error
	}{
		{
			name: "should register successfully with valid request",
			req: &models.CreateUserRequest{
				Username: "testuser",
				Password: testRegisterPassword,
				Email:    "test@example.com",
			},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.IsEmailPlatformBannedFn = func(ctx context.Context, email string) (bool, error) {
					return false, nil
				}
				ur.CreateFn = func(ctx context.Context, user *models.User) error {
					// Verify bcrypt hash was generated
					if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(testRegisterPassword)); err != nil {
						t.Errorf("password hash does not match: %v", err)
					}
					user.ID = "user-1"
					return nil
				}
			},
			wantErr: false,
		},
		{
			name: "should fail when username is too short",
			req: &models.CreateUserRequest{
				Username: "ab",
				Password: testRegisterPassword,
			},
			wantErr: true,
			errIs:   pkg.ErrBadRequest,
		},
		{
			name: "should fail when password is too short",
			req: &models.CreateUserRequest{
				Username: "testuser",
				Password: "short",
			},
			wantErr: true,
			errIs:   pkg.ErrBadRequest,
		},
		{
			name: "should fail when email is platform banned",
			req: &models.CreateUserRequest{
				Username: "testuser",
				Password: testRegisterPassword,
				Email:    "banned@example.com",
			},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.IsEmailPlatformBannedFn = func(ctx context.Context, email string) (bool, error) {
					return true, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrForbidden,
		},
		{
			name: "should fail when username already exists",
			req: &models.CreateUserRequest{
				Username: "existing",
				Password: testRegisterPassword,
			},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.CreateFn = func(ctx context.Context, user *models.User) error {
					return errors.New("UNIQUE constraint failed: users.username")
				}
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			sessionRepo := &testutil.MockSessionRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo, sessionRepo)
			}

			svc := newTestAuthService(userRepo, sessionRepo)
			tokens, err := svc.Register(context.Background(), tc.req)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tokens.AccessToken == "" {
				t.Error("expected non-empty access token")
			}
			if tokens.RefreshToken == "" {
				t.Error("expected non-empty refresh token")
			}
		})
	}
}

func TestLogin(t *testing.T) {
	hashedPassword := preHashPassword(t, "password123")

	tests := []struct {
		name      string
		req       *models.LoginRequest
		setupRepo func(*testutil.MockUserRepo, *testutil.MockSessionRepo)
		wantErr   bool
		errIs     error
	}{
		{
			name: "should login successfully with correct credentials",
			req:  &models.LoginRequest{Username: "testuser", Password: "password123"},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.GetByUsernameFn = func(ctx context.Context, username string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						Username:     "testuser",
						PasswordHash: hashedPassword,
						Status:       models.UserStatusOffline,
					}, nil
				}
			},
			wantErr: false,
		},
		{
			name: "should return unauthorized when password is wrong",
			req:  &models.LoginRequest{Username: "testuser", Password: "wrongpassword"},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.GetByUsernameFn = func(ctx context.Context, username string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						Username:     "testuser",
						PasswordHash: hashedPassword,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name: "should return unauthorized when user not found",
			req:  &models.LoginRequest{Username: "nonexistent", Password: "password123"},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.GetByUsernameFn = func(ctx context.Context, username string) (*models.User, error) {
					return nil, pkg.ErrNotFound
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name: "should return forbidden when user is platform banned",
			req:  &models.LoginRequest{Username: "banned", Password: "password123"},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.GetByUsernameFn = func(ctx context.Context, username string) (*models.User, error) {
					return &models.User{
						ID:               "user-2",
						Username:         "banned",
						PasswordHash:     hashedPassword,
						IsPlatformBanned: true,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			sessionRepo := &testutil.MockSessionRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo, sessionRepo)
			}

			svc := newTestAuthService(userRepo, sessionRepo)
			tokens, err := svc.Login(context.Background(), tc.req)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tokens.AccessToken == "" {
				t.Error("expected non-empty access token")
			}
			if tokens.RefreshToken == "" {
				t.Error("expected non-empty refresh token")
			}
			if tokens.User.Username != "testuser" {
				t.Errorf("expected username 'testuser', got %q", tokens.User.Username)
			}
			if tokens.User.PasswordHash != "" {
				t.Error("password hash should be cleared from returned user")
			}
		})
	}
}

func TestRefreshToken(t *testing.T) {
	tests := []struct {
		name      string
		token     string
		setupRepo func(*testutil.MockUserRepo, *testutil.MockSessionRepo)
		wantErr   bool
		errIs     error
	}{
		{
			name:  "should refresh successfully with valid token",
			token: "valid-refresh-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return &models.Session{
						ID:           "session-1",
						UserID:       "user-1",
						RefreshToken: token,
						ExpiresAt:    time.Now().Add(24 * time.Hour),
					}, nil
				}
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:       "user-1",
						Username: "testuser",
					}, nil
				}
			},
			wantErr: false,
		},
		{
			name:  "should return unauthorized when token not found",
			token: "invalid-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return nil, pkg.ErrNotFound
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:  "should return unauthorized when token is expired",
			token: "expired-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return &models.Session{
						ID:           "session-1",
						UserID:       "user-1",
						RefreshToken: token,
						ExpiresAt:    time.Now().Add(-1 * time.Hour),
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:  "should return forbidden when user is banned",
			token: "banned-user-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return &models.Session{
						ID:           "session-2",
						UserID:       "user-2",
						RefreshToken: token,
						ExpiresAt:    time.Now().Add(24 * time.Hour),
					}, nil
				}
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:               "user-2",
						Username:         "banned",
						IsPlatformBanned: true,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			sessionRepo := &testutil.MockSessionRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo, sessionRepo)
			}

			svc := newTestAuthService(userRepo, sessionRepo)
			tokens, err := svc.RefreshToken(context.Background(), tc.token)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tokens.AccessToken == "" {
				t.Error("expected non-empty access token")
			}
			if tokens.RefreshToken == "" {
				t.Error("expected non-empty refresh token")
			}
		})
	}
}

func TestValidateAccessToken(t *testing.T) {
	svc := newTestAuthService(&testutil.MockUserRepo{}, &testutil.MockSessionRepo{})

	// Generate a valid token for test cases
	validClaims := &models.TokenClaims{
		UserID:   "user-1",
		Username: "testuser",
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{models.AudienceAPI},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "mqvi",
		},
	}
	validToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("failed to create test token: %v", err)
	}

	// Token signed with wrong key
	wrongKeyToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims).SignedString([]byte("wrong-secret"))
	if err != nil {
		t.Fatalf("failed to create wrong-key token: %v", err)
	}

	// Token signed with RSA (wrong signing method) — use none algorithm workaround
	rsaClaims := &models.TokenClaims{
		UserID:   "user-1",
		Username: "testuser",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
		},
	}
	// Manually craft a token with "none" algorithm header to test signing method check
	noneToken := jwt.NewWithClaims(jwt.SigningMethodNone, rsaClaims)
	noneTokenStr, err := noneToken.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("failed to create none-signed token: %v", err)
	}

	tests := []struct {
		name    string
		token   string
		wantErr bool
		errIs   error
		checkFn func(t *testing.T, claims *models.TokenClaims)
	}{
		{
			name:    "should return claims for valid token",
			token:   validToken,
			wantErr: false,
			checkFn: func(t *testing.T, claims *models.TokenClaims) {
				if claims.UserID != "user-1" {
					t.Errorf("expected user_id 'user-1', got %q", claims.UserID)
				}
				if claims.Username != "testuser" {
					t.Errorf("expected username 'testuser', got %q", claims.Username)
				}
			},
		},
		{
			name:    "should return unauthorized for token signed with wrong key",
			token:   wrongKeyToken,
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:    "should return unauthorized for wrong signing method",
			token:   noneTokenStr,
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:    "should return unauthorized for garbage token",
			token:   "not-a-jwt-token",
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			claims, err := svc.ValidateAccessToken(tc.token)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.checkFn != nil {
				tc.checkFn(t, claims)
			}
		})
	}
}

func TestAudienceSeparation(t *testing.T) {
	svc := newTestAuthService(&testutil.MockUserRepo{}, &testutil.MockSessionRepo{})

	mkToken := func(audiences ...string) string {
		claims := &models.TokenClaims{
			UserID:   "user-1",
			Username: "testuser",
			RegisteredClaims: jwt.RegisteredClaims{
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
				IssuedAt:  jwt.NewNumericDate(time.Now()),
				Issuer:    "mqvi",
			},
		}
		if len(audiences) > 0 {
			claims.Audience = jwt.ClaimStrings(audiences)
		}
		s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testJWTSecret))
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		return s
	}

	apiTok := mkToken(models.AudienceAPI)
	fileTok := mkToken(models.AudienceFile)
	legacyTok := mkToken()

	if _, err := svc.ValidateAccessToken(apiTok); err != nil {
		t.Errorf("aud=api on API path: %v", err)
	}
	if _, err := svc.ValidateAccessToken(fileTok); err == nil {
		t.Error("aud=file MUST be rejected on API path (token confusion)")
	}
	if _, err := svc.ValidateAccessToken(legacyTok); err == nil {
		t.Error("legacy token MUST be rejected on API path")
	}

	if _, err := svc.ValidateFileToken(fileTok); err != nil {
		t.Errorf("aud=file on file path: %v", err)
	}
	if _, err := svc.ValidateFileToken(apiTok); err == nil {
		t.Error("aud=api MUST be rejected on file path")
	}
	if _, err := svc.ValidateFileToken(legacyTok); err == nil {
		t.Error("legacy token MUST be rejected on file path (file tokens started with aud claim)")
	}
}

func TestGenerateTokens_StampsAudienceAndTokenVersion(t *testing.T) {
	user := &models.User{
		ID:           "user-1",
		Username:     "testuser",
		TokenVersion: 7,
		PasswordHash: "x",
	}
	svc := newTestAuthService(
		&testutil.MockUserRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.User, error) { return user, nil },
		},
		&testutil.MockSessionRepo{
			CreateFn: func(_ context.Context, _ *models.Session) error { return nil },
		},
	)

	authSvc, ok := svc.(*authService)
	if !ok {
		t.Fatal("expected *authService")
	}
	tokens, err := authSvc.generateTokens(context.Background(), user)
	if err != nil {
		t.Fatalf("generateTokens: %v", err)
	}

	accessClaims, err := svc.ValidateAccessToken(tokens.AccessToken)
	if err != nil {
		t.Fatalf("validate access: %v", err)
	}
	if accessClaims.TokenVersion != 7 {
		t.Errorf("access tv: got %d want 7", accessClaims.TokenVersion)
	}
	if !slices.Contains(accessClaims.Audience, models.AudienceAPI) {
		t.Errorf("access aud: got %v want includes %q", accessClaims.Audience, models.AudienceAPI)
	}

	fileClaims, err := svc.ValidateFileToken(tokens.FileToken)
	if err != nil {
		t.Fatalf("validate file: %v", err)
	}
	if fileClaims.TokenVersion != 7 {
		t.Errorf("file tv: got %d want 7", fileClaims.TokenVersion)
	}
	if !slices.Contains(fileClaims.Audience, models.AudienceFile) {
		t.Errorf("file aud: got %v want includes %q", fileClaims.Audience, models.AudienceFile)
	}
}

func TestChangePassword(t *testing.T) {
	hashedPassword := preHashPassword(t, "currentpass1")

	tests := []struct {
		name        string
		userID      string
		currentPass string
		newPass     string
		setupRepo   func(*testutil.MockUserRepo)
		wantErr     bool
		errIs       error
	}{
		{
			name:        "should change password successfully",
			userID:      "user-1",
			currentPass: "currentpass1",
			newPass:     "newpassword1",
			setupRepo: func(ur *testutil.MockUserRepo) {
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						PasswordHash: hashedPassword,
					}, nil
				}
				ur.UpdatePasswordFn = func(ctx context.Context, userID, oldHash, newHash string) (int, error) {
					if err := bcrypt.CompareHashAndPassword([]byte(newHash), []byte("newpassword1")); err != nil {
						t.Errorf("new password hash does not match: %v", err)
					}
					return 1, nil
				}
			},
			wantErr: false,
		},
		{
			name:        "should fail when current password is wrong",
			userID:      "user-1",
			currentPass: "wrongpassword",
			newPass:     "newpassword1",
			setupRepo: func(ur *testutil.MockUserRepo) {
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						PasswordHash: hashedPassword,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:        "should fail when new password is the same as current",
			userID:      "user-1",
			currentPass: "currentpass1",
			newPass:     "currentpass1",
			setupRepo: func(ur *testutil.MockUserRepo) {
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						PasswordHash: hashedPassword,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrBadRequest,
		},
		{
			// The policy is checked only once the current password proves out, so this case
			// has to authenticate before it can be rejected for length.
			name:        "should fail when new password is too short",
			userID:      "user-1",
			currentPass: "currentpass1",
			newPass:     "short",
			setupRepo: func(ur *testutil.MockUserRepo) {
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{ID: "user-1", Username: "testuser", PasswordHash: hashedPassword}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrBadRequest,
		},
		{
			name:        "should fail when the new password contains the username",
			userID:      "user-1",
			currentPass: "currentpass1",
			newPass:     "my-testuser-password",
			setupRepo: func(ur *testutil.MockUserRepo) {
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{ID: "user-1", Username: "testuser", PasswordHash: hashedPassword}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo)
			}

			svc := newTestAuthService(userRepo, &testutil.MockSessionRepo{})
			_, err := svc.ChangePassword(context.Background(), tc.userID, tc.currentPass, tc.newPass)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestLogout(t *testing.T) {
	tests := []struct {
		name      string
		token     string
		setupRepo func(*testutil.MockUserRepo, *testutil.MockSessionRepo)
		wantErr   bool
	}{
		{
			name:  "should logout successfully",
			token: "valid-refresh-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return &models.Session{
						ID:     "session-1",
						UserID: "user-1",
					}, nil
				}
				var statusUpdated bool
				ur.UpdateStatusFn = func(ctx context.Context, userID string, status models.UserStatus) error {
					if status != models.UserStatusOffline {
						t.Errorf("expected status offline, got %v", status)
					}
					statusUpdated = true
					return nil
				}
				sr.DeleteByIDFn = func(ctx context.Context, id string) error {
					if !statusUpdated {
						t.Error("expected status update before session delete")
					}
					if id != "session-1" {
						t.Errorf("expected session id 'session-1', got %q", id)
					}
					return nil
				}
			},
			wantErr: false,
		},
		{
			name:  "should return nil when token not found",
			token: "nonexistent-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return nil, pkg.ErrNotFound
				}
			},
			wantErr: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			sessionRepo := &testutil.MockSessionRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo, sessionRepo)
			}

			svc := newTestAuthService(userRepo, sessionRepo)
			err := svc.Logout(context.Background(), tc.token)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// The client translates password rejections from the code, not the English text. A path that
// returns an uncoded error shows a Turkish user an English string — which is what happened
// while the length check lived in the model and ran before the service ever saw the password.
func TestPasswordRejectionsCarryACode(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantCode string
	}{
		{"too short", "short", pkg.CodePasswordTooShort},
		{"contains the username", "xx-testuser-xxxxx", pkg.CodePasswordContainsIdentity},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			userRepo.IsEmailPlatformBannedFn = func(context.Context, string) (bool, error) { return false, nil }

			svc := newTestAuthService(userRepo, &testutil.MockSessionRepo{})
			_, err := svc.Register(context.Background(), &models.CreateUserRequest{
				Username: "testuser",
				Password: tt.password,
			})

			if err == nil {
				t.Fatal("expected the password to be rejected")
			}
			if got := pkg.CodeOf(err); got != tt.wantCode {
				t.Errorf("code = %q, want %q", got, tt.wantCode)
			}
		})
	}
}
