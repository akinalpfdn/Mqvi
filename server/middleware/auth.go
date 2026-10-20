package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
)

// AuthMiddleware validates JWT tokens on incoming requests.
type AuthMiddleware struct {
	authService services.AuthService
	userRepo    repository.UserRepository
}

func NewAuthMiddleware(authService services.AuthService, userRepo repository.UserRepository) *AuthMiddleware {
	return &AuthMiddleware{
		authService: authService,
		userRepo:    userRepo,
	}
}

// authFailure is how Require answers a request it could not authenticate: a coded error passed to
// pkg.Error, or a status and message.
type authFailure struct {
	err     error
	status  int
	message string
}

func (f *authFailure) write(w http.ResponseWriter) {
	if f.err != nil {
		pkg.Error(w, f.err)
		return
	}
	pkg.ErrorWithMessage(w, f.status, f.message)
}

// authenticate runs every check a request must pass to act as a user. Require and Optional share
// it so the two can never disagree about who is signed in.
func (m *AuthMiddleware) authenticate(r *http.Request) (*models.User, *models.TokenClaims, *authFailure) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return nil, nil, &authFailure{status: http.StatusUnauthorized, message: "authorization header required"}
	}

	if !strings.HasPrefix(authHeader, "Bearer ") {
		return nil, nil, &authFailure{status: http.StatusUnauthorized, message: "invalid authorization format, use: Bearer <token>"}
	}
	tokenString := strings.TrimPrefix(authHeader, "Bearer ")

	claims, err := m.authService.ValidateAccessToken(tokenString)
	if err != nil {
		return nil, nil, &authFailure{err: err}
	}

	// A device signed out elsewhere still holds an unexpired access token.
	if err := m.authService.ValidateSession(r.Context(), claims); err != nil {
		return nil, nil, &authFailure{err: err}
	}

	user, err := m.userRepo.GetActiveByID(r.Context(), claims.UserID)
	if err != nil {
		return nil, nil, &authFailure{status: http.StatusUnauthorized, message: "user not found"}
	}

	if user.IsPlatformBanned {
		return nil, nil, &authFailure{status: http.StatusForbidden, message: "account suspended"}
	}

	// Reject tokens issued before a password change / force-logout.
	if claims.TokenVersion != user.TokenVersion {
		return nil, nil, &authFailure{status: http.StatusUnauthorized, message: "token revoked"}
	}

	user.PasswordHash = ""
	return user, claims, nil
}

func withUser(r *http.Request, user *models.User, claims *models.TokenClaims) *http.Request {
	ctx := context.WithValue(r.Context(), ctxkeys.User, user)
	ctx = context.WithValue(ctx, ctxkeys.AuthSessionID, claims.SessionID)
	return r.WithContext(ctx)
}

// Require enforces a valid JWT token. Returns 401 if missing or invalid.
func (m *AuthMiddleware) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, claims, failure := m.authenticate(r)
		if failure != nil {
			failure.write(w)
			return
		}
		next.ServeHTTP(w, withUser(r, user, claims))
	})
}

// Optional attaches the user when the request carries a valid token and lets it through either
// way — for public routes that are better with an identity but must work without one.
func (m *AuthMiddleware) Optional(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, claims, failure := m.authenticate(r); failure == nil {
			r = withUser(r, user, claims)
		}
		next.ServeHTTP(w, r)
	})
}
