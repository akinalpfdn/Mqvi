package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/authcookie"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

type AuthHandler struct {
	authService      services.AuthService
	loginLimiter     *ratelimit.LoginRateLimiter
	registerLimiter  *ratelimit.LoginRateLimiter
	forgotPwdLimiter *ratelimit.LoginRateLimiter
	resetPwdLimiter  *ratelimit.LoginRateLimiter
	urlSigner        services.FileURLSigner
	fileCookieTTL    time.Duration
}

// NewAuthHandler creates a new AuthHandler. All limiters may be nil to disable rate limiting.
func NewAuthHandler(
	authService services.AuthService,
	loginLimiter *ratelimit.LoginRateLimiter,
	registerLimiter *ratelimit.LoginRateLimiter,
	forgotPwdLimiter *ratelimit.LoginRateLimiter,
	resetPwdLimiter *ratelimit.LoginRateLimiter,
	urlSigner services.FileURLSigner,
	fileCookieTTL time.Duration,
) *AuthHandler {
	return &AuthHandler{
		authService:      authService,
		loginLimiter:     loginLimiter,
		registerLimiter:  registerLimiter,
		forgotPwdLimiter: forgotPwdLimiter,
		resetPwdLimiter:  resetPwdLimiter,
		urlSigner:        urlSigner,
		fileCookieTTL:    fileCookieTTL,
	}
}

// Register handles POST /api/auth/register
// First registered user automatically becomes Owner.
// IP-based rate limiting prevents registration spam.
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.registerLimiter != nil && !h.registerLimiter.Allow(ip) {
		retryAfter := h.registerLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many registration attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.CreateUserRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	tokens, err := h.authService.Register(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	authcookie.Set(w, tokens.FileToken, h.fileCookieTTL)
	h.signTokenURLs(tokens)
	pkg.JSON(w, http.StatusCreated, tokens)
}

// Login handles POST /api/auth/login
// IP-based rate limiting protects against brute-force. Successful login resets the counter.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.loginLimiter != nil && !h.loginLimiter.Allow(ip) {
		retryAfter := h.loginLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many login attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.LoginRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	tokens, err := h.authService.Login(r.Context(), &req)
	if err != nil {
		// Soft-deleted account: 403 with structured payload so the frontend can
		// show the recovery UI ("Restore your account?"). Custom envelope:
		//   { success: false, error: "account_deleted", data: { username, ... } }
		var deletedErr *services.AccountDeletedError
		if errors.As(err, &deletedErr) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": false,
				"error":   "account_deleted",
				"data": map[string]string{
					"username":            deletedErr.Username,
					"deleted_at":          deletedErr.DeletedAt,
					"permanent_delete_at": deletedErr.PermanentDeleteAt,
				},
			})
			return
		}
		pkg.Error(w, err)
		return
	}

	if h.loginLimiter != nil {
		h.loginLimiter.Reset(ip)
	}

	authcookie.Set(w, tokens.FileToken, h.fileCookieTTL)
	h.signTokenURLs(tokens)
	pkg.JSON(w, http.StatusOK, tokens)
}

// Refresh handles POST /api/auth/refresh
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.RefreshToken == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	tokens, err := h.authService.RefreshToken(r.Context(), req.RefreshToken)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	authcookie.Set(w, tokens.FileToken, h.fileCookieTTL)
	h.signTokenURLs(tokens)
	pkg.JSON(w, http.StatusOK, tokens)
}

// Logout handles POST /api/auth/logout
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.authService.Logout(r.Context(), req.RefreshToken); err != nil {
		pkg.Error(w, err)
		return
	}

	authcookie.Clear(w)
	pkg.JSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

// Me handles GET /api/users/me (requires auth middleware).
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	user.AvatarURL = h.urlSigner.SignURLPtr(user.AvatarURL)
	user.WallpaperURL = h.urlSigner.SignURLPtr(user.WallpaperURL)
	pkg.JSON(w, http.StatusOK, user)
}

// signTokenURLs signs avatar and wallpaper URLs in the token response user.
func (h *AuthHandler) signTokenURLs(tokens *services.AuthTokens) {
	tokens.User.AvatarURL = h.urlSigner.SignURLPtr(tokens.User.AvatarURL)
	tokens.User.WallpaperURL = h.urlSigner.SignURLPtr(tokens.User.WallpaperURL)
}

// ChangePassword handles POST /api/users/me/password
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "current_password and new_password are required")
		return
	}

	tokens, err := h.authService.ChangePassword(r.Context(), user.ID, req.CurrentPassword, req.NewPassword)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	authcookie.Set(w, tokens.FileToken, h.fileCookieTTL)
	h.signTokenURLs(tokens)
	pkg.JSON(w, http.StatusOK, tokens)
}

// ChangeEmail handles PUT /api/users/me/email
// Requires current password. Empty new_email removes the email (sets NULL).
func (h *AuthHandler) ChangeEmail(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.ChangeEmailRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.authService.ChangeEmail(r.Context(), user.ID, req.Password, req.NewEmail); err != nil {
		pkg.Error(w, err)
		return
	}

	var emailResult *string
	if req.NewEmail != "" {
		emailResult = &req.NewEmail
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"message": "email updated",
		"email":   emailResult,
	})
}

// ForgotPassword handles POST /api/auth/forgot-password
// Returns same success response whether email exists or not (enumeration protection).
// IP-based rate limiting + per-email 90s cooldown.
func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.forgotPwdLimiter != nil && !h.forgotPwdLimiter.Allow(ip) {
		retryAfter := h.forgotPwdLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many requests, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.ForgotPasswordRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	cooldown, err := h.authService.ForgotPassword(r.Context(), req.Email)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if cooldown > 0 {
		pkg.JSON(w, http.StatusOK, map[string]any{
			"message":  "cooldown active",
			"cooldown": cooldown,
		})
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{
		"message": "if the email exists, a reset link has been sent",
	})
}

// ResetPassword handles POST /api/auth/reset-password
// Validates token, updates password, deletes token.
// IP-based rate limiting prevents brute-force token guessing.
func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.resetPwdLimiter != nil && !h.resetPwdLimiter.Allow(ip) {
		retryAfter := h.resetPwdLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.ResetPasswordRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.authService.ResetPassword(r.Context(), req.Token, req.NewPassword); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{
		"message": "password has been reset successfully",
	})
}

// SoftDeleteSelf — DELETE /api/users/me
// Body: { "password": "..." }
// Soft-deletes the current user (recoverable via login). Disconnects sessions/WS.
func (h *AuthHandler) SoftDeleteSelf(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Password == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "password is required")
		return
	}

	if err := h.authService.SoftDeleteSelf(r.Context(), user.ID, req.Password); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "account soft-deleted"})
}

// RestoreAccount — POST /api/auth/restore
// Body: { "username": "...", "password": "..." }
// Restores a soft-deleted account and returns auth tokens.
// Rate-limited identically to /auth/login: an attacker who hits the login
// limiter cannot pivot to /auth/restore for the same brute-force budget.
func (h *AuthHandler) RestoreAccount(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.loginLimiter != nil && !h.loginLimiter.Allow(ip) {
		retryAfter := h.loginLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "username and password are required")
		return
	}

	tokens, err := h.authService.RestoreAccount(r.Context(), req.Username, req.Password)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if h.loginLimiter != nil {
		h.loginLimiter.Reset(ip)
	}

	authcookie.Set(w, tokens.FileToken, h.fileCookieTTL)
	h.signTokenURLs(tokens)
	pkg.JSON(w, http.StatusOK, tokens)
}
